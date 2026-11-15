"""The comparison stars of RW Aurigae: twenty steady stars measured in the same frames. Not a job.

How they were chosen (once, before any change of RW Aurigae was measured): bright point sources found in the same
rows of the same frames as RW Aurigae in both seasons, with a peak between 0.15 and 3 times that of RW Aurigae,
were identified with the brightest Gaia DR3 star within 15 arcsec. A star was kept when Gaia does not mark it
variable, its RUWE is below 1.4, no other star within 3 magnitudes lies closer than 15 arcsec, and the detection is
within 2 arcsec of the Gaia position. They lie 5 to 125 arcmin from RW Aurigae, along the rows of the frames.

The values are an excerpt of Gaia DR3 (epoch J2016.0), read through the MAST cone search: source id, position in
degrees, proper motion in mas a year (pmra is the motion in right ascension times cos(dec)), G magnitude.
"""

STARS = [
    {"source_id": "156336779511773440", "ra": 76.8636611, "dec": 30.3832915, "pmra": -4.124, "pmdec": -1.251, "phot_g_mean_mag": 9.900},
    {"source_id": "156345919202053376", "ra": 76.5339356, "dec": 30.3890422, "pmra": -2.494, "pmdec": -8.961, "phot_g_mean_mag": 10.592},
    {"source_id": "156387150888769920", "ra": 77.2903537, "dec": 30.4389512, "pmra": 4.295, "pmdec": -5.501, "phot_g_mean_mag": 11.011},
    {"source_id": "156339287772535424", "ra": 76.7068986, "dec": 30.3808432, "pmra": 3.563, "pmdec": -12.208, "phot_g_mean_mag": 10.626},
    {"source_id": "156351176243125888", "ra": 76.6778791, "dec": 30.4103414, "pmra": 4.805, "pmdec": -9.086, "phot_g_mean_mag": 10.257},
    {"source_id": "156384745707122432", "ra": 77.1242288, "dec": 30.4217312, "pmra": 0.480, "pmdec": -0.482, "phot_g_mean_mag": 13.209},
    {"source_id": "156339665729807616", "ra": 76.8158073, "dec": 30.3778413, "pmra": 1.147, "pmdec": -0.374, "phot_g_mean_mag": 13.343},
    {"source_id": "156386459397780352", "ra": 77.4266874, "dec": 30.4337123, "pmra": 5.889, "pmdec": -5.333, "phot_g_mean_mag": 11.394},
    {"source_id": "156387219608248704", "ra": 77.2799983, "dec": 30.4408142, "pmra": -4.839, "pmdec": -17.212, "phot_g_mean_mag": 11.114},
    {"source_id": "156338978534891392", "ra": 76.6866396, "dec": 30.3801444, "pmra": 2.363, "pmdec": -2.103, "phot_g_mean_mag": 13.357},
    {"source_id": "157070630507517824", "ra": 75.9890168, "dec": 30.2874456, "pmra": 0.505, "pmdec": -1.352, "phot_g_mean_mag": 11.531},
    {"source_id": "156347564172645504", "ra": 76.3222693, "dec": 30.3401209, "pmra": -0.849, "pmdec": -7.978, "phot_g_mean_mag": 11.900},
    {"source_id": "156383199518911744", "ra": 77.0887720, "dec": 30.3863550, "pmra": -9.803, "pmdec": -7.276, "phot_g_mean_mag": 12.346},
    {"source_id": "156384917505820416", "ra": 77.0923463, "dec": 30.4197207, "pmra": -0.343, "pmdec": -6.912, "phot_g_mean_mag": 12.180},
    {"source_id": "156347740268209792", "ra": 76.3208368, "dec": 30.3608938, "pmra": 4.141, "pmdec": -5.829, "phot_g_mean_mag": 12.987},
    {"source_id": "156388078601663616", "ra": 77.4502792, "dec": 30.4596797, "pmra": -0.182, "pmdec": 15.391, "phot_g_mean_mag": 11.033},
    {"source_id": "156385222447198208", "ra": 77.1842574, "dec": 30.4500096, "pmra": 2.223, "pmdec": -2.293, "phot_g_mean_mag": 13.402},
    {"source_id": "180170171511598208", "ra": 78.5417824, "dec": 30.4794313, "pmra": 0.159, "pmdec": -2.067, "phot_g_mean_mag": 10.942},
    {"source_id": "180219370362714112", "ra": 78.3378573, "dec": 30.4987983, "pmra": 14.778, "pmdec": -15.229, "phot_g_mean_mag": 11.651},
    {"source_id": "3446798322617035008", "ra": 79.3695539, "dec": 30.5162798, "pmra": -0.312, "pmdec": -1.598, "phot_g_mean_mag": 12.737},
]
