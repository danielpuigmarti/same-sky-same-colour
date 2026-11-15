"""Job places: the well-known places of the sky that the box of the site suggests while a visitor types.

    python -m sx.run places             write site/data/places.json
    python -m sx.run places --fresh     ask SIMBAD again, in place of reading the answers kept from an earlier run

Everything in the file comes from the SIMBAD astronomical database (CDS, Strasbourg), read through its table
service. Four groups of objects are asked for, each with all its identifiers:

    the Messier objects (an identifier "M 1" to "M 110");
    the objects that carry a common name (an identifier that starts with "NAME");
    the objects nearer than 10 parsec (a parallax of 100 mas or more);
    the variable stars (an identifier that starts with "V*") that 500 papers or more cite.

Of those the job keeps (group_of): every Messier object; every star that has a common name and a Bayer letter, a
Flamsteed number or a number of the Bright Star Catalogue; every other object with a common name that enough
papers cite (fewer are asked of one that also has an NGC or IC number, many more of one whose names are all
abbreviations); the nearest stars and brown dwarfs; and the variable stars. Planets are left out, since their star is in the list, and so is what has no single place to
look at: streams of stars, superclusters, voids, parts of a galaxy, and anything whose position SIMBAD gives to
a tenth of a degree or worse, or not at all.

Each entry has one name to show and its other names (names_of), a kind in plain words (kind_of) and a position
in degrees (ICRS). SIMBAD gives positions for the year 2000. An object with a measured proper motion is moved to
2026.0, the epoch of site/data/names.json, so that a star is listed where it is in the photos. A star that moves
more than half an arcsec a year also carries its catalogue astrometry, as the fast stars of names.json do, so that
a page can move it to the date of a photo.

The entries are in the order in which they are suggested: the most cited first.

Needs the network the first time. The answers are kept in the cache folder of the pipeline (sx.s3.cache_dir),
so a rerun writes the same file; --fresh asks again.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
import unicodedata
import warnings
from pathlib import Path
from typing import Iterable, Optional

import requests

from sx import s3

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "data" / "places.json"

SIMBAD_TAP = (
    "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync",
    "https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
    "https://simbad.u-strasbg.fr/simbad/sim-tap/sync",
)
"""The table service of SIMBAD: the mirror at the Center for Astrophysics first, then Strasbourg."""

EPOCH = 2026.0
"""The year the positions are given for: the epoch of site/data/names.json."""
SIMBAD_EPOCH = 2000.0
"""The year SIMBAD gives its positions for."""
FAST_MAS_PER_YEAR = 500.0
"""A star that moves more than this carries its catalogue astrometry (the same limit as in jobs/names.py)."""

ASKED_PARALLAX = 100.0
"""mas: the nearest objects are asked for down to this parallax (10 parsec)."""
NEAR_PARALLAX = 150.0
"""mas: the stars and brown dwarfs nearer than this (6.7 parsec) are kept."""
VARIABLE_MIN_REFS = 500
"""A variable star is well known when this many papers cite it."""
NAMED_MIN_REFS = 50
"""An object with a common name is kept when this many papers cite it."""
NAMED_CATALOGUE_MIN_REFS = 20
"""The same for an object that also has an NGC or IC number: what an observer looks up by its common name."""
SHORT_NAMED_MIN_REFS = 500
"""The same for an object whose common names are all short forms or designations ("ome Cen Cluster", "OMC-1")."""
BRIGHT_MAG = 5.0
"""A star brighter than this in the V band carries its magnitude (`vmag`), so that a row can warn that SPHEREx
saturates on it (the site says so below magnitude 4; the rest of the margin is for the file's reader)."""
MIN_PRECISION = 3
"""SIMBAD's code for how finely a coordinate is given: 3 is an arcminute. A place given more coarsely is a
region of degrees, with nothing to centre a photo on."""

MAX_ALIASES = 6
"""The most other names an entry keeps. The names that come first in names_of() are kept."""
MAX_BYTES = 200_000
MAX_ROWS = 500_000
"""Asked of SIMBAD as the most rows of one answer; an answer that long is taken as cut short."""

BASIC = ("b.oid, b.main_id, b.otype, b.nbref, b.ra, b.dec, b.ra_prec, b.dec_prec, b.pmra, b.pmdec, b.plx_value, "
         "b.rvz_radvel, b.rvz_type")
GROUPS = {
    "messier": "SELECT oidref FROM ident WHERE id LIKE 'M %'",
    "named": "SELECT oidref FROM ident WHERE id LIKE 'NAME %'",
    "near": f"SELECT oid FROM basic WHERE plx_value >= {ASKED_PARALLAX:g}",
    "variable": "SELECT s.oid FROM basic AS s JOIN ident AS v ON v.oidref = s.oid "
                f"WHERE s.nbref >= {VARIABLE_MIN_REFS} AND v.id LIKE 'V* %'",
}
"""The objects asked for, each group as the list of its SIMBAD object numbers."""

# -- names -----------------------------------------------------------------------------------------------

GREEK = {
    "alf": "Alpha", "bet": "Beta", "gam": "Gamma", "del": "Delta", "eps": "Epsilon", "zet": "Zeta", "eta": "Eta",
    "tet": "Theta", "iot": "Iota", "kap": "Kappa", "lam": "Lambda", "mu.": "Mu", "nu.": "Nu", "ksi": "Xi",
    "omi": "Omicron", "pi.": "Pi", "rho": "Rho", "sig": "Sigma", "tau": "Tau", "ups": "Upsilon", "phi": "Phi",
    "chi": "Chi", "psi": "Psi", "ome": "Omega",
}
"""The Greek letters as SIMBAD abbreviates them in a star's designation, and their names."""

CONSTELLATIONS = {
    "And": "Andromedae", "Ant": "Antliae", "Aps": "Apodis", "Aqr": "Aquarii", "Aql": "Aquilae", "Ara": "Arae",
    "Ari": "Arietis", "Aur": "Aurigae", "Boo": "Boötis", "Cae": "Caeli", "Cam": "Camelopardalis", "Cnc": "Cancri",
    "CVn": "Canum Venaticorum", "CMa": "Canis Majoris", "CMi": "Canis Minoris", "Cap": "Capricorni",
    "Car": "Carinae", "Cas": "Cassiopeiae", "Cen": "Centauri", "Cep": "Cephei", "Cet": "Ceti",
    "Cha": "Chamaeleontis", "Cir": "Circini", "Col": "Columbae", "Com": "Comae Berenices",
    "CrA": "Coronae Australis", "CrB": "Coronae Borealis", "Crv": "Corvi", "Crt": "Crateris", "Cru": "Crucis",
    "Cyg": "Cygni", "Del": "Delphini", "Dor": "Doradus", "Dra": "Draconis", "Equ": "Equulei", "Eri": "Eridani",
    "For": "Fornacis", "Gem": "Geminorum", "Gru": "Gruis", "Her": "Herculis", "Hor": "Horologii", "Hya": "Hydrae",
    "Hyi": "Hydri", "Ind": "Indi", "Lac": "Lacertae", "Leo": "Leonis", "LMi": "Leonis Minoris", "Lep": "Leporis",
    "Lib": "Librae", "Lup": "Lupi", "Lyn": "Lyncis", "Lyr": "Lyrae", "Men": "Mensae", "Mic": "Microscopii",
    "Mon": "Monocerotis", "Mus": "Muscae", "Nor": "Normae", "Oct": "Octantis", "Oph": "Ophiuchi", "Ori": "Orionis",
    "Pav": "Pavonis", "Peg": "Pegasi", "Per": "Persei", "Phe": "Phoenicis", "Pic": "Pictoris", "Psc": "Piscium",
    "PsA": "Piscis Austrini", "Pup": "Puppis", "Pyx": "Pyxidis", "Ret": "Reticuli", "Sge": "Sagittae",
    "Sgr": "Sagittarii", "Sco": "Scorpii", "Scl": "Sculptoris", "Sct": "Scuti", "Ser": "Serpentis",
    "Sex": "Sextantis", "Tau": "Tauri", "Tel": "Telescopii", "Tri": "Trianguli", "TrA": "Trianguli Australis",
    "Tuc": "Tucanae", "UMa": "Ursae Majoris", "UMi": "Ursae Minoris", "Vel": "Velorum", "Vir": "Virginis",
    "Vol": "Volantis", "Vul": "Vulpeculae",
}
"""The 88 constellations: the abbreviation of the International Astronomical Union, and the genitive of the Latin
name, which is how a star is named after its constellation ("Alpha Lyrae")."""

PREFER = (
    "47 Tucanae", "Omega Centauri", "Cat's Eye Nebula", "Virgo A", "Sagittarius A*", "Rigil Kentaurus",
    "Black Eye Galaxy", "Kapteyn's Star", "Van Maanen's Star", "Lalande 21185", "Epsilon Eridani", "51 Pegasi",
    "55 Cancri", "Upsilon Andromedae", "CW Leonis", "Upper Scorpius", "Draco Dwarf Galaxy", "Carina Dwarf Galaxy",
    "Sextans Dwarf Galaxy", "SN 1006", "Tycho's SN", "Vela SNR", "Einstein Cross", "Palomar 5", "Dumbbell Nebula",
    "Little Dumbbell Nebula", "IC 348",
    "IC 2602", "NGC 7023",
)
"""Names that are shown when an object has them among its names, whatever the rule of names_of() would pick:
the cases where the rule picks a name that fewer people know. Every one is a name SIMBAD gives, or the spelling
of one of its designations."""

TYPE_WORDS = {
    "galaxy": ("Galaxy",), "active galaxy": ("Galaxy",), "nebula": ("Nebula",), "dark nebula": ("Nebula",),
    "planetary nebula": ("Nebula",), "supernova remnant": ("Nebula",), "star-forming region": ("Nebula",),
    "gas cloud": ("Cloud",), "star cluster": ("Cluster",), "cluster of galaxies": ("Cluster",),
    "group of galaxies": ("Group", "Quintet", "Sextet", "Triplet"), "pulsar": ("Pulsar",),
    "group of stars": ("Association", "Cluster"), "region of the sky": ("Field",),
}
"""The word a common name of each kind ends in when it says what the object is: such a name is shown first."""
OTHER_TYPE_WORDS = ("Galaxy", "Galaxies", "Nebula", "Cluster", "Cloud", "Pulsar", "Group", "Loop", "Complex",
                    "Association", "Field", "Quintet", "Sextet", "Triplet", "Object", "Region", "Arm", "Bubble",
                    "Remnant", "Star", "star")

SHORT_WORDS = {"Gal", "Neb", "Cl", "dSph", "dE", "de", "GMC", "MCld", "DCld", "Mol", "Assoc", "Ass", "Reg", "G",
               "Gr", "Grp", "Nuc", "PSR", "IR", "IRC"}
"""Words that abbreviate another word in a common name of SIMBAD, besides the abbreviations of the constellations
and of the Greek letters. A name with one of them is shown only when there is no other."""

STARS = {"star", "double star", "variable star", "young star", "X-ray binary star", "brown dwarf", "white dwarf",
         "neutron star", "pulsar", "nova", "supernova"}
"""The kinds that are a star, or what is left of one."""
LEFT_OUT = {"planet", "part of a galaxy", "stream of stars", "supercluster of galaxies", "void"}
"""Kinds that are not listed: see the top of the file."""

SURVEYS = {"WISE": "WISE", "WISEA": "WISE", "WISEP": "WISE", "WISEPA": "WISE", "WISEPC": "WISE", "CWISE": "WISE",
           "CWISEP": "WISE", "2MASS": "2MASS", "2MASSW": "2MASS", "2MASSI": "2MASS", "DENIS": "DENIS",
           "DENIS-P": "DENIS", "SDSS": "SDSS", "SCR": "SCR", "UGPS": "UGPS", "ULAS": "ULAS", "SIMP": "SIMP"}
"""Surveys that name an object by its position ("WISE J085510.83-071442.5"), and the name each goes by in the
short form that papers use ("WISE 0855-0714")."""
SURVEY_NAME = re.compile(r"^(\S+) J(\d\d)(\d\d)[\d.]*([+-])(\d\d)(\d\d)[\d.]*([A-Z]{0,2})$")

COARSE_CATALOGUES = re.compile(
    r"^(BD|CD|CPD|G|L|LP|LHS|LTT|NLTT|Z|MCG|ESO|UGC|UGCA|PGC|LEDA|2MASS\w*|2MASX|WISE\w*|CWISE\w*|SDSS|Gaia|TYC|TIC|"
    r"GSC|ICRF|QSO|PLX|GJ|HIP|SAO|PN|PK|ClG|RX|1RXS|DENIS\S*|SCR|UGPS|ULAS|SIMP|\*\*|WDS|CCDM|ADS)[ +-]|^\[")
"""Catalogues that number everything in a zone or a survey. When SIMBAD's main identifier comes from one of
them it is not a name anyone uses, and it is not shown as one."""


def tidy(identifier: str) -> str:
    """An identifier with single spaces: SIMBAD pads its numbers ("M   1", "NGC  6543")."""
    return re.sub(r"\s+", " ", identifier).strip()


def key(name: str) -> str:
    """A name as it is compared: letters and digits only, lower case, without accents."""
    plain = unicodedata.normalize("NFKD", name)
    return re.sub(r"[^a-z0-9]", "", "".join(c for c in plain if not unicodedata.combining(c)).lower())


def natural(text: str) -> str:
    """A text in which numbers sort by value: "NGC 650" before "NGC 6543"."""
    return re.sub(r"\d+", lambda m: m.group(0).zfill(8), text)


def spell(designation: str) -> Optional[str]:
    """A star's designation with its letter and its constellation written out: "alf Lyr" is "Alpha Lyrae",
    "omi02 Eri" is "Omicron2 Eridani", "61 Cyg A" is "61 Cygni A", "V2500 Oph" is "V2500 Ophiuchi". None when the
    text does not end in a constellation."""
    m = re.fullmatch(r"(\S+) ([A-Za-z]{3})((?: \S+)?)", designation)
    if not m or m.group(2) not in CONSTELLATIONS:
        return None
    first, constellation, part = m.groups()
    letter = re.fullmatch(r"([a-z]{2}[a-z.]|[A-Za-z])(\d\d)?", first)
    if letter and (letter.group(1) in GREEK or len(letter.group(1)) == 1):
        first = GREEK.get(letter.group(1), letter.group(1)) + (str(int(letter.group(2))) if letter.group(2) else "")
    return f"{first} {CONSTELLATIONS[constellation]}{part}"


def short_survey_name(identifier: str) -> Optional[str]:
    """The short form of a position-based name, as it is written in papers: "WISE J085510.83-071442.5" is
    "WISE 0855-0714". None for any other identifier."""
    m = SURVEY_NAME.match(identifier)
    if not m or m.group(1) not in SURVEYS:
        return None
    survey, h, hm, sign, d, dm, part = m.groups()
    return f"{SURVEYS[survey]} {h}{hm}{sign}{d}{dm}{part}"


def is_legacy(name: str) -> bool:
    """True for a common name written all in capitals, the way old catalogues did ("CRAB NEB"): it is not kept.
    A short single word in capitals is an acronym ("LMC") and stays, and so does a name with a number in it."""
    letters = [c for c in name if c.isalpha()]
    if not letters or any(c.islower() for c in letters) or any(c.isdigit() for c in name):
        return False
    return " " in name or len(letters) > 5


def is_short_form(name: str) -> bool:
    """True for a common name that abbreviates: one with the abbreviation of a constellation or of a Greek letter
    in it ("Ori Nebula", "eta Car Nebula"), with another known short word ("Fornax dSph"), with a word all in
    capitals that is longer than an acronym, or with no lower-case letter at all ("LMC", "OMC-1"). A name with a
    number and no word of three lower-case letters is a designation, not a name ("Sh 2-68 FIR"), and counts too."""
    if not any(c.islower() for c in name):
        return True
    if any(c.isdigit() for c in name) and not any(sum(c.islower() for c in word) >= 3 for word in name.split(" ")):
        return True
    for word in re.split(r"[ /+-]", name):
        if word in SHORT_WORDS or (word in CONSTELLATIONS and word != "Leo") or word in GREEK or word + "." in GREEK:
            return True
        if len(word) > 5 and word.isalpha() and word.isupper():
            return True
    return False


def common_names(ids: Iterable[str], main_id: str, kind: str) -> tuple[list[str], list[str]]:
    """The common names SIMBAD gives an object, best first, as (names that can be shown, short forms).

    Among the names that can be shown, SIMBAD's own main name comes first. For a star, a name of one word comes
    before one that ends in a word for what the object is, and that before any other ("Polaris" before "North
    Star"); for anything else, a name that ends in the word for its kind comes first ("Andromeda Galaxy" before
    "Andromeda"). Then the shorter name, then the alphabet. A name of one word that SIMBAD writes with "the" in
    front ("the Egg") counts as a short form, and so does a name that only adds the letter of a component to
    another ("Sirius A" beside "Sirius")."""
    names: dict[str, str] = {}
    for written in sorted({tidy(i)[5:] for i in ids if i.startswith("NAME ")}):
        bare = re.sub(r"^the ", "", written)
        name = bare[:1].upper() + bare[1:]
        if not is_legacy(written) and (name not in names or names[name].startswith("the ")):
            names[name] = written
    main = tidy(main_id)[5:] if main_id.startswith("NAME ") else None
    own = TYPE_WORDS.get(kind, ())
    keys = {key(n) for n in names}

    def is_short(name: str) -> bool:
        written = names[name]
        if is_short_form(name) or (written.startswith("the ") and " " not in name):
            return True
        part = re.fullmatch(r"(.+) [A-D][a-d]?", name)
        return bool(part and key(part.group(1)) in keys)

    def order(name: str):
        last = name.split(" ")[-1]
        if kind in STARS:
            form = 0 if " " not in name else 1 if last in own or last in OTHER_TYPE_WORDS else 2
        else:
            form = 0 if last in own else 1 if last in OTHER_TYPE_WORDS else 2
        return (names[name] != main, form, len(name), name)

    full = sorted((n for n in names if n and not is_short(n)), key=order)
    short = sorted((n for n in names if n and is_short(n)), key=lambda n: (names[n] != main, len(n), n))
    return full, short


CATALOGUES = (
    (1, r"M (\d+)", "M {0}"),
    (5, r"NGC (\d+[A-Z]?)", "NGC {0}"),
    (6, r"IC (\d+[A-Z]?)", "IC {0}"),
    (6, r"X (.+ X-\d+)", "{0}"),
    (7, r"(SN \d{4}[A-Za-z]{0,2})", "{0}"),
    (7, r"3C (\d+(?:\.[1-9])?)(?:\.0)?", "3C {0}"),
    (7, r"Mrk (\d+)", "Mrk {0}"),
    (7, r"APG (\d+)", "Arp {0}"),
    (7, r"ACO (\d+)", "Abell {0}"),
    (7, r"ACO S (\d+)", "Abell S{0}"),
    (7, r"Cl Pal (\d+)", "Palomar {0}"),
    (7, r"LAL 21185", "Lalande 21185"),
    (7, r"SH 2-(\d+)", "Sh 2-{0}"),
    (7, r"Barnard (\d+)", "Barnard {0}"),
    (7, r"Cl (Melotte|Collinder) (\d+)", "{0} {1}"),
    (7, r"(W \d+)", "{0}"),
    (7.6, r"(PSR [BJ]\d{4}[+-]\d+)", "{0}"),
    (7.8, r"(Wolf|Ross) (\d+)( [A-Z])?", "{0} {1}{2}"),
    (8.5, r"GJ (\d+(?:\.[1-9])?)(?:\.0)?( [A-Z]{1,2})?", "GJ {0}{1}"),
    (11, r"HD (\d+)", "HD {0}"),
)
"""Catalogues whose numbers people type, as (rank, how SIMBAD writes an identifier, how it is written here). The
ranks are those of designations(): the lower, the more a name is used."""
STAR_CATALOGUES = (8.5, 11)
"""The ranks of the catalogues that are kept for stars only: other objects have such numbers by accident."""


def designations(ids: Iterable[str], main_id: str = "", star: bool = True, bare: bool = False) -> list[str]:
    """The designations of an object that are kept, the one most used first.

    By rank: Messier (1); a Bayer letter (2); a Flamsteed number or a Latin letter (3); a variable-star name of
    letters (4); NGC (5); IC, and the name of an X-ray source (6); the other catalogues that have a name (7); a
    pulsar's number (7.6); a number of Wolf or Ross (7.8); a variable-star name with a number (8); and, for a star
    only, the numbers of the Gliese and Henry Draper catalogues (8.5, 11).

    SIMBAD's main identifier is the designation it holds to be the most used: when its own rank is 7.8 or better
    it comes right after a Messier number (1.5). Otherwise it has rank 7.5, also when it comes from no catalogue
    listed here, unless that is a catalogue of a zone or a survey (COARSE_CATALOGUES).

    A star that has no common name (`bare`) and nothing up to here is a faint neighbour of the Sun. It is known by
    SIMBAD's main identifier even from such a catalogue (8.8), or else by the short form of a name that a survey
    gave it after its position (9), the one of the main identifier first."""
    main = tidy(main_id)
    ranked: list[tuple[float, str, str]] = []
    for raw in sorted(set(ids) | ({main_id} if main_id else set())):
        i = tidy(raw)
        rank: Optional[float] = None
        name = ""
        if i.startswith("* ") or i.startswith("V* "):
            text = i.split(" ", 1)[1]
            name = spell(text) or ""
            first = text.split(" ")[0]
            if name:
                rank = 2 if first[:3] in GREEK else 3 if i.startswith("* ") else 8 if re.match(r"V\d", first) else 4
        elif short_survey_name(i):
            name, rank = short_survey_name(i) or "", 9
        else:
            for r, pattern, form in CATALOGUES:
                m = re.fullmatch(pattern, i)
                if m and (star or r not in STAR_CATALOGUES):
                    name, rank = form.format(*(g or "" for g in m.groups())), r
                    break
        if i == main and not i.startswith("NAME "):
            if rank is None:
                name, rank = re.sub(r"^EM\* ", "", i), 8.8 if COARSE_CATALOGUES.match(i) else 7.5
            elif rank != 9:
                rank = 1.5 if 1 < rank <= 7.8 else rank if rank == 1 else 7.5
        if rank is not None:
            ranked.append((rank, natural(name), name))
    last_resort = bare and star and not any(rank < 8.8 for rank, _, _ in ranked)
    if not last_resort or any(rank == 8.8 for rank, _, _ in ranked):
        ranked = [r for r in ranked if r[0] != 9]
    if not last_resort:
        ranked = [r for r in ranked if r[0] != 8.8]
    if short_survey_name(main):
        ranked = [(8.9, s, n) if n == short_survey_name(main) else (r, s, n) for r, s, n in ranked]
    out: list[str] = []
    seen: set[str] = set()
    for _, _, name in sorted(ranked):
        # a name is left out when it is there already, or only adds the letter of a component to one that is
        part = re.fullmatch(r"(.+) [A-D][a-d]?", name)
        if key(name) in seen or (part and key(part.group(1)) in seen):
            continue
        seen.add(key(name))
        out.append(name)
    return out


def names_of(ids: Iterable[str], main_id: str, kind: str) -> tuple[str, list[str]]:
    """The name to show and the other names of an object, from its SIMBAD identifiers.

    Shown is: a name of PREFER; else the best common name that abbreviates nothing; else the first designation;
    else a short common name; else SIMBAD's main identifier. The other names are the first designation, up to
    three more common names, up to two short ones of one or two words, then the other designations: at most
    MAX_ALIASES, none twice."""
    ids = list(ids)
    full, short = common_names(ids, main_id, kind)
    marks = designations(ids, main_id, star=kind in STARS, bare=not full)
    have = {key(n) for n in full + marks + short}
    preferred = [p for p in PREFER if key(p) in have]
    if preferred:
        name = preferred[0]
    elif full:
        name = full[0]
    elif marks:
        name = marks[0]
    elif short:
        name = short[0]
    else:
        name = tidy(main_id)
    rest = [n for n in full if key(n) != key(name)][:3]
    brief = [n for n in short if n.count(" ") <= 1][:2]
    aliases, seen = [], {key(name)}
    for n in marks[:1] + rest + brief + marks[1:]:
        if key(n) and key(n) not in seen:
            seen.add(key(n))
            aliases.append(n)
    return name, aliases[:MAX_ALIASES]


# -- kinds -----------------------------------------------------------------------------------------------

KINDS = {
    "star": "* PM* HV* MS* Be* BS* Em* Ev* AB* C* S* HB* HS* RG* OH* pA* Ma* sg* s*b s*r s*y WR* Pe* LM* dS* gD* "
            "SX* bC* a2* BY* RS* Ro* El*",
    "double star": "** SB* EB*",
    "variable star": "V* Pu* Ir* Er* LP* Mi* Ce* cC* RR* RV* WV* RC* CV* Sy*",
    "young star": "Y*O TT* Or* Ae*",
    "X-ray binary star": "XB* HXB LXB",
    "brown dwarf": "BD*",
    "white dwarf": "WD*",
    "neutron star": "N*",
    "pulsar": "Psr",
    "nova": "No*",
    "supernova": "SN*",
    "planet": "Pl",
    "planetary nebula": "PN",
    "nebula": "ISM Cld GNe RNe HII bub sh flt CGb glb HH out PoC",
    "dark nebula": "DNe",
    "gas cloud": "MoC cor HVC",
    "star-forming region": "SFR",
    "supernova remnant": "SNR",
    "star cluster": "Cl* GlC OpC",
    "group of stars": "As* MGr",
    "stream of stars": "St*",
    "galaxy": "G AGN LIN SyG Sy1 Sy2 rG EmG GiC BiC GiG GiP H2G LSB SBG bCG",
    "quasar": "QSO",
    "active galaxy": "Bla BLL",
    "pair of galaxies": "PaG",
    "interacting galaxies": "IG",
    "group of galaxies": "GrG CGG",
    "cluster of galaxies": "ClG PCG",
    "supercluster of galaxies": "SCG",
    "part of a galaxy": "PoG",
    "region of the sky": "reg",
    "void": "vid",
    "black hole": "BH",
    "gravitational lens": "gLS gLe LeI LeG LeQ",
    "gravitational-wave event": "GWE",
    "X-ray source": "X ULX",
    "gamma-ray source": "gam",
    "gamma-ray burst": "gB",
    "radio source": "Rad HI Mas cm mR mm smm rB",
    "infrared source": "IR FIR MIR NIR",
    "ultraviolet source": "UV",
    "transient event": "ev Lev",
}
"""Plain words for the object types of SIMBAD (its table otypedef)."""
CANDIDATES = {
    "**?": "**", "As?": "As*", "BY?": "BY*", "Cl?": "Cl*", "C?G": "ClG", "Gl?": "GlC", "CV?": "CV*", "No?": "No*",
    "EB?": "EB*", "El?": "El*", "Ev?": "Ev*", "AB?": "AB*", "Mi?": "Mi*", "C*?": "C*", "Ce?": "Ce*", "HB?": "HB*",
    "RR?": "RR*", "HS?": "HS*", "LP?": "LP*", "OH?": "OH*", "pA?": "pA*", "PN?": "PN", "RB?": "RG*", "RV?": "RV*",
    "S*?": "S*", "WD?": "WD*", "WV?": "WV*", "G?": "G", "AG?": "AGN", "Q?": "QSO", "Bz?": "Bla", "BL?": "BLL",
    "Gr?": "GrG", "BH?": "BH", "LS?": "gLS", "Le?": "gLe", "LI?": "LeI", "LM?": "LM*", "BD?": "BD*", "MS?": "MS*",
    "BS?": "BS*", "Be?": "Be*", "Ma?": "Ma*", "N*?": "N*", "bC?": "bC*", "sg?": "sg*", "s?b": "s*b", "WR?": "WR*",
    "s?r": "s*r", "s?y": "s*y", "Pe?": "Pe*", "RC?": "RC*", "a2?": "a2*", "Pl?": "Pl", "SN?": "SN*", "V*?": "V*",
    "Er?": "Er*", "Pu?": "Pu*", "Ro?": "Ro*", "Y*?": "Y*O", "Ae?": "Ae*", "TT?": "TT*", "of?": "out",
    "PCG?": "PCG", "SC?": "SCG", "SR?": "SNR", "UX?": "ULX", "SB?": "SB*", "RS?": "RS*", "Sy?": "Sy*",
    "XB?": "XB*", "HX?": "HXB", "LX?": "LXB",
}
"""The types SIMBAD gives a candidate, and the type each is a candidate for."""
KIND_OF = {code: kind for kind, codes in KINDS.items() for code in codes.split()}


def kind_of(otype: Optional[str]) -> str:
    """What an object is, in plain words, from its SIMBAD type. A candidate has the kind it is a candidate for,
    except that a star that may be variable is a star; a type that is not known here is an "object"."""
    if otype in KIND_OF:
        return KIND_OF[otype]
    kind = KIND_OF.get(CANDIDATES.get(otype or "", ""), "object")
    return "star" if kind == "variable star" else kind


def kind_in_list(o: dict) -> str:
    """The kind an entry is given. A Messier object that SIMBAD does not take for a real object (M 73: four stars
    that only look like a cluster) is a group of stars."""
    return "group of stars" if o["otype"] == "err" else kind_of(o["otype"])


# -- which objects ---------------------------------------------------------------------------------------


def group_of(o: dict) -> Optional[str]:
    """The reason an object is listed: "messier", "named star", "named", "near" or "variable"; None when it is
    not. `o` has the columns of BASIC and `ids`, its identifiers. A common name counts when it can be shown: an
    object whose common names all abbreviate, or are designations (common_names), has to be cited much more."""
    if o["ra"] is None or o["dec"] is None:
        return None
    ids = [tidy(i) for i in o["ids"]]
    if any(re.fullmatch(r"M \d+", i) for i in ids):
        return "messier"
    kind = kind_of(o["otype"])
    if o["otype"] == "err" or kind in LEFT_OUT or min(o["ra_prec"] or 0, o["dec_prec"] or 0) < MIN_PRECISION:
        return None
    refs = o["nbref"] or 0
    full, short = common_names(ids, o["main_id"], kind)
    if full:
        if kind in STARS and any(i.startswith("* ") or i.startswith("HR ") for i in ids):
            return "named star"
        catalogued = any(re.fullmatch(r"(NGC|IC) \d+[A-Z]?", i) for i in ids)
        if refs >= (NAMED_CATALOGUE_MIN_REFS if catalogued else NAMED_MIN_REFS):
            return "named"
    elif short and refs >= SHORT_NAMED_MIN_REFS:
        return "named"
    if kind in STARS and (o["plx_value"] or 0.0) >= NEAR_PARALLAX:
        return "near"
    if kind in STARS and refs >= VARIABLE_MIN_REFS and any(i.startswith("V* ") for i in ids):
        return "variable"
    return None


# -- positions -------------------------------------------------------------------------------------------


def moved(rows: list[dict], epoch: float = EPOCH) -> list[tuple[float, float]]:
    """(ra, dec) in degrees at `epoch` for objects given at SIMBAD_EPOCH, seen from the centre of the solar
    system. One with a proper motion is moved along it, with its parallax and its radial velocity when SIMBAD
    has them (an object without a measured distance is taken to be far away); one without stays where it is."""
    import astropy.units as u
    from astropy.coordinates import Distance, SkyCoord
    from astropy.time import Time

    out = [(float(r["ra"]), float(r["dec"])) for r in rows]
    moving = [k for k, r in enumerate(rows) if r["pmra"] is not None and r["pmdec"] is not None]
    if not moving:
        return out
    pick = [rows[k] for k in moving]
    start = SkyCoord(
        ra=[r["ra"] for r in pick] * u.deg, dec=[r["dec"] for r in pick] * u.deg,
        pm_ra_cosdec=[r["pmra"] for r in pick] * u.mas / u.yr, pm_dec=[r["pmdec"] for r in pick] * u.mas / u.yr,
        distance=Distance(parallax=[r["plx_value"] if (r["plx_value"] or 0) > 0 else 1e-3 for r in pick] * u.mas),
        radial_velocity=[velocity(r) or 0.0 for r in pick] * u.km / u.s,
        obstime=Time(SIMBAD_EPOCH, format="jyear", scale="tcb"), frame="icrs",
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # a distance far beyond the stars is what "far away" means here
        end = start.apply_space_motion(new_obstime=Time(epoch, format="jyear", scale="tcb"))
    for k, ra, dec in zip(moving, end.ra.deg, end.dec.deg):
        out[k] = (float(ra) % 360.0, float(dec))
    return out


def velocity(o: dict) -> Optional[float]:
    """The radial velocity of an object in km/s, when SIMBAD gives one as a velocity (not as a redshift)."""
    return float(o["rvz_radvel"]) if o["rvz_type"] == "v" and o["rvz_radvel"] is not None else None


def speed(o: dict) -> float:
    """The proper motion of an object, mas a year; 0 when SIMBAD has none."""
    return math.hypot(o["pmra"], o["pmdec"]) if o["pmra"] is not None and o["pmdec"] is not None else 0.0


# -- the file --------------------------------------------------------------------------------------------


def entries(objects: Iterable[dict]) -> list[dict]:
    """The entries of the file, from the objects SIMBAD gave: the ones to list, named, placed and ordered.

    The order is that of the suggestions: the most cited first, then by name. Two objects never get the same name
    to show: the less cited of them takes its next name."""
    kept = [o for o in objects if group_of(o)]
    kept.sort(key=lambda o: (-(o["nbref"] or 0), o["oid"]))
    places = moved(kept)
    out, taken = [], set()
    for o, (ra, dec) in zip(kept, places):
        kind = kind_in_list(o)
        name, aliases = names_of(o["ids"], o["main_id"], kind)
        while key(name) in taken and aliases:
            name, aliases = aliases[0], aliases[1:]
        if key(name) in taken:
            continue
        taken.add(key(name))
        e = {"name": name, "aliases": aliases, "kind": kind, "ra": round(ra, 6), "dec": round(dec, 6)}
        if speed(o) > FAST_MAS_PER_YEAR and (o["plx_value"] or 0) > 0:
            rv = velocity(o)
            e["fast"] = True
            e["catalogue"] = {
                "ra": round(float(o["ra"]), 7), "dec": round(float(o["dec"]), 7), "epoch": SIMBAD_EPOCH,
                "pmra": round(float(o["pmra"]), 3), "pmdec": round(float(o["pmdec"]), 3),
                "parallax": round(float(o["plx_value"]), 4), "rv": None if rv is None else round(rv, 3),
            }
        vmag = o.get("vmag")
        if kind in STARS and vmag is not None and vmag < BRIGHT_MAG:
            e["vmag"] = round(float(vmag), 2)
        out.append((o, e))
    out.sort(key=lambda pair: (-(pair[0]["nbref"] or 0), key(pair[1]["name"]), pair[0]["oid"]))
    return [e for _, e in out]


def document(places: list[dict]) -> dict:
    return {
        "version": 1,
        "epoch": EPOCH,
        "about": "Well-known places of the sky, the most cited first. Each has a name to show, its other names, a "
                 "kind in plain words, and ra and dec in degrees (ICRS): where the object is at `epoch`, a star with a "
                 "measured proper motion having been moved there from its position of 2000. A `fast` star, one that "
                 "moves more than half an arcsec a year, also carries its catalogue astrometry: position and epoch, "
                 "proper motion in mas a year (pmra is the motion in right ascension times cos(dec)), parallax in "
                 "mas, radial velocity in km/s or null. A star brighter than magnitude 5 in the V band also carries `vmag`. `letters` and `constellations` say how the designations of "
                 "stars are spelled: the abbreviations SIMBAD uses, and the words written here.",
        "source": "SIMBAD astronomical database, CDS, Strasbourg (Wenger et al. 2000, A&AS 143, 9), tables basic "
                  "and ident, read through its TAP service. This research has made use of the SIMBAD database, "
                  "operated at CDS, Strasbourg, France.",
        "licence": "Open Database License (ODbL), the licence of SIMBAD",
        "selection": f"The Messier objects; stars with a common name and a Bayer, Flamsteed or Bright Star number; "
                     f"other objects with a common name that at least {NAMED_MIN_REFS} papers cite "
                     f"({NAMED_CATALOGUE_MIN_REFS} for one with an NGC or IC number, {SHORT_NAMED_MIN_REFS} for one "
                     f"whose common names are all abbreviations); stars and brown dwarfs with a "
                     f"parallax of at least {NEAR_PARALLAX:g} mas; variable stars that at least {VARIABLE_MIN_REFS} "
                     f"papers cite.",
        "letters": {abbreviation.rstrip("."): name for abbreviation, name in GREEK.items()},
        "constellations": dict(CONSTELLATIONS),
        "count": len(places),
        "places": places,
    }


def text_of(doc: dict) -> str:
    """The file as text: one entry on each line, so that a change shows as the lines that changed."""
    head = {k: v for k, v in doc.items() if k != "places"}
    lines = [json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in doc["places"]]
    body = json.dumps(head, ensure_ascii=False, indent=1)
    return body[: body.rindex("\n}")] + ',\n "places": [\n' + ",\n".join(lines) + "\n ]\n}\n"


# -- asking SIMBAD ---------------------------------------------------------------------------------------


def rows_of(answer: dict) -> list[dict]:
    """The rows of an answer of the table service (its JSON form) as dicts by column name."""
    names = [c["name"] for c in answer["metadata"]]
    return [dict(zip(names, row)) for row in answer["data"]]


def ask(query: str, fresh: bool = False, tries: int = 3) -> list[dict]:
    """The rows of a query to SIMBAD. The answer is kept in the cache folder and read from there the next time,
    unless `fresh` is set."""
    cache = s3.cache_dir() / ("simbad_" + hashlib.sha1(query.encode()).hexdigest()[:16] + ".json")
    if cache.exists() and not fresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    err: Exception = RuntimeError("no try made")
    for k in range(tries):
        for url in SIMBAD_TAP:
            try:
                r = requests.post(url, data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json",
                                             "MAXREC": str(MAX_ROWS), "QUERY": query}, timeout=300)
                if r.status_code != 200:
                    raise RuntimeError(f"status {r.status_code} from {url}")
                rows = rows_of(r.json())
                if len(rows) >= MAX_ROWS:
                    raise RuntimeError(f"{len(rows)} rows: the answer was cut short")
                tmp = cache.with_name(f"{cache.name}.{os.getpid()}.tmp")
                tmp.write_text(json.dumps(rows), encoding="utf-8")
                os.replace(tmp, cache)
                return rows
            except (requests.RequestException, ValueError, KeyError, TypeError, RuntimeError) as e:
                err = e
        time.sleep(5 * (k + 1))
    raise RuntimeError(f"SIMBAD did not answer: {err}")


def gather(fresh: bool = False) -> list[dict]:
    """Every object of the four groups, once, with its identifiers in `ids`."""
    by: dict[int, dict] = {}
    for group in GROUPS.values():
        for r in ask(f"SELECT {BASIC} FROM basic AS b WHERE b.oid IN ({group})", fresh):
            by.setdefault(r["oid"], {**r, "ids": set()})
        for r in ask(f"SELECT i.oidref, i.id FROM ident AS i WHERE i.oidref IN ({group})", fresh):
            if r["oidref"] in by:
                by[r["oidref"]]["ids"].add(r["id"])
        for r in ask(f"SELECT f.oidref, f.flux FROM flux AS f WHERE f.filter = 'V' AND f.oidref IN ({group})", fresh):
            if r["oidref"] in by and r["flux"] is not None:
                by[r["oidref"]]["vmag"] = float(r["flux"])
    return [{**o, "ids": sorted(o["ids"])} for _, o in sorted(by.items())]


def main(argv: list[str]) -> int:
    objects = gather(fresh="--fresh" in argv)
    places = entries(objects)
    text = text_of(document(places))
    size = len(text.encode("utf-8"))
    groups: dict[str, int] = {}
    for o in objects:
        g = group_of(o)
        if g:
            groups[g] = groups.get(g, 0) + 1
    print(f"{len(objects)} objects from SIMBAD; {len(places)} listed ({', '.join(f'{n} {g}' for g, n in sorted(groups.items()))}); "
          f"{sum(1 for p in places if p.get('fast'))} fast stars; {size} bytes")
    if size >= MAX_BYTES:
        raise RuntimeError(f"places.json would be {size} bytes, over the limit of {MAX_BYTES}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_name(f"{OUT.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, OUT)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
