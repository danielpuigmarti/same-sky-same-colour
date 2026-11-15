"""phot.py: the photometry rule on synthetic stamps whose answer is known."""
import math

import numpy as np
import pytest

from sx import phot
from sx.fits import FLAG

OMEGA = (6.15 / 206264.806) ** 2


def stamp(n=121, cx=60.3, cy=59.8, peak=2.0, sigma=1.1, bkg=0.5, noise=0.0, seed=1):
    yy, xx = np.mgrid[:n, :n]
    img = bkg + peak * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma**2))
    if noise:
        img = img + np.random.default_rng(seed).normal(0, noise, img.shape)
    return img.astype(np.float32), cx, cy


def test_flux_of_a_gaussian_in_a_flat_background():
    img, cx, cy = stamp()
    p = phot.aperture(img, np.full_like(img, 1e-4), None, cx, cy, 5, (40, 55), OMEGA)
    # the sum of the Gaussian inside r <= 5 sigma-ish: compare with the same sum computed directly
    yy, xx = np.mgrid[:121, :121]
    r = np.hypot(xx - cx, yy - cy)
    want = float(((img - 0.5)[r <= 5]).sum()) * OMEGA * 1e9
    assert p.flux == pytest.approx(want, rel=1e-6)
    assert p.bkg == pytest.approx(0.5, abs=1e-6)
    assert p.n_ap == int((r <= 5).sum()) and p.n_use == p.n_ap


def test_flux_is_in_mjy_from_mjy_per_sr():
    img = np.zeros((121, 121), np.float32) + 1.0
    img[60, 60] += 10.0
    p = phot.aperture(img, None, None, 60, 60, 0.5, (40, 55), OMEGA)
    assert p.flux == pytest.approx(10.0 * OMEGA * 1e9, rel=1e-6)  # 10 MJy/sr over one pixel
    assert OMEGA * 1e9 == pytest.approx(0.8885, abs=0.001)  # one pixel is 0.89 mJy per MJy/sr


def test_ring_median_ignores_a_star_in_the_ring_through_clipping():
    img, cx, cy = stamp(bkg=1.0, noise=0.02)
    img[60, 100] += 50.0  # a star in the ring (r about 40)
    p = phot.aperture(img, None, None, cx, cy, 3, (35, 50), OMEGA)
    assert p.bkg == pytest.approx(1.0, abs=0.01)


def test_source_pixels_are_left_out_of_the_ring_unless_told_not_to():
    img, cx, cy = stamp(bkg=1.0, noise=0.02)
    flags = np.zeros(img.shape, np.int32)
    img[:, 70:] += 0.04  # a band in the ring that clipping does not reject (two sigma), flagged as SOURCE
    flags[:, 70:] = FLAG["SOURCE"]
    a = phot.aperture(img, None, flags, cx, cy, 3, (35, 55), OMEGA)
    b = phot.aperture(img, None, flags, cx, cy, 3, (35, 55), OMEGA, skip_source_in_ring=False)
    assert a.bkg == pytest.approx(1.0, abs=0.01)
    assert b.bkg > a.bkg + 0.005


def test_bad_pixels_in_the_aperture_are_scaled_for_and_too_many_give_nan():
    img = np.ones((121, 121), np.float32)
    img[55:66, 55:66] = 2.0
    flags = np.zeros(img.shape, np.int32)
    r = np.hypot(*(np.mgrid[:121, :121] - 60.0))
    ap = r <= 4
    flags[60, 60] = FLAG["HOT"]  # one bad pixel: its share is filled in
    p = phot.aperture(img, None, flags, 60, 60, 4, (40, 55), OMEGA)
    assert p.n_use == p.n_ap - 1
    assert p.flux == pytest.approx(ap.sum() * 1.0 * OMEGA * 1e9, rel=1e-6)
    flags[ap & (np.arange(121)[:, None] % 2 == 0)] = FLAG["COLD"]  # about half bad
    q = phot.aperture(img, None, flags, 60, 60, 4, (40, 55), OMEGA)
    assert math.isnan(q.flux) and math.isnan(q.err)


def test_source_and_fullsample_bits_do_not_make_a_pixel_bad():
    assert phot.BAD_MASK & FLAG["SOURCE"] == 0 and phot.BAD_MASK & FLAG["FULLSAMPLE"] == 0
    assert phot.BAD_MASK & FLAG["HOT"] and phot.BAD_MASK & FLAG["NONLINEAR"] and phot.BAD_MASK & FLAG["PERSIST"]
    assert phot.BAD_MASK == sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17))


def test_error_follows_the_variance_and_the_background_term():
    img, cx, cy = stamp(noise=0.0)
    n = int((np.hypot(*(np.mgrid[:121, :121] - 60.0)) <= 2).sum())
    var = np.full_like(img, 0.01)
    p = phot.aperture(img, var, None, 60.0, 60.0, 2, (40, 55), OMEGA)
    # no scatter in the ring: only the VARIANCE term is left
    assert p.err == pytest.approx(math.sqrt(0.01 * n) * OMEGA * 1e9, rel=1e-6)
    noisy, _, _ = stamp(noise=0.05, peak=0.0)
    q = phot.aperture(noisy, None, None, 60.0, 60.0, 2, (40, 55), OMEGA)
    assert q.err == pytest.approx(0.05 * n * math.sqrt(math.pi / 2 / q.n_ring) * OMEGA * 1e9, rel=0.1)


def test_flux_of_an_empty_aperture_is_zero_within_the_error_over_many_stamps():
    zs = []
    for seed in range(200):
        img, _, _ = stamp(peak=0.0, noise=0.05, seed=seed)
        p = phot.aperture(img, np.full_like(img, 0.05**2), None, 60.0, 60.0, 2, (40, 55), OMEGA)
        zs.append(p.flux / p.err)
    assert abs(np.mean(zs)) < 0.3 and 0.7 < np.std(zs) < 1.3


def test_a_ring_with_too_few_pixels_gives_none():
    img = np.ones((20, 20), np.float32)
    assert phot.aperture(img, None, None, 10, 10, 2, (40, 55), OMEGA) is None


def test_clipped_median_rejects_outliers():
    a = np.concatenate([np.random.default_rng(0).normal(5, 0.1, 500), [100.0, 90.0, -50.0]])
    med, sd, n = phot.clipped_median(a)
    assert med == pytest.approx(5, abs=0.02) and sd < 0.15 and n <= 500
