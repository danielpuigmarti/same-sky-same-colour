## Datasets

- SPHEREx Data Release 1, Level 2 spectral images | https://irsa.ipac.caltech.edu/Missions/spherex.html | Public, no usage restrictions (IRSA terms of use, https://irsa.ipac.caltech.edu/data_use_terms.html); acknowledgement asked for | the images the site shows, read from the public bucket nasa-irsa-spherex under dr1/level2/; the test fixtures are excerpts of the frames listed below
- SPHEREx Data Release 1, list of frames from the IRSA image search (collection spherex_dr1) | https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1 | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/idx: the names, times and outlines of the frames in one tile of the frame index, and the list the tile is checked against
- SPHEREx frame level2_2026W11_2A_0501_1D2_spx_l2b-v27-2026-234.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2026W11_2A/l2b-v27-2026-234/2/level2_2026W11_2A_0501_1D2_spx_l2b-v27-2026-234.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/frames/barnard-d2: four byte ranges and the stamp expected from them
- SPHEREx frame level2_2025W46_1A_0287_1D4_spx_l2b-v27-2026-206.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W46_1A/l2b-v27-2026-206/4/level2_2025W46_1A_0287_1D4_spx_l2b-v27-2026-206.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/frames/eps-indi-d4: four byte ranges and the stamp expected from them; tests/fixtures/wave/reference.json: wavelength and bandwidth at 200 pixels of detector 4
- SPHEREx frame level2_2025W23_2B_0441_4D5_spx_l2b-v27-2026-201.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W23_2B/l2b-v27-2026-201/5/level2_2025W23_2B_0441_4D5_spx_l2b-v27-2026-201.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/frames/eps-indi-d5: four byte ranges and the stamp expected from them; tests/fixtures/wave/reference.json: wavelength and bandwidth at 200 pixels of detector 5
- SPHEREx frame level2_2025W35_1A_0146_1D5_spx_l2b-v27-2026-230.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0146_1D5_spx_l2b-v27-2026-230.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/showcase/barnard-d5: one stamp of 64 by 64 pixels with its flags
- SPHEREx frame level2_2025W35_1A_0146_3D5_spx_l2b-v27-2026-230.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0146_3D5_spx_l2b-v27-2026-230.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/showcase/barnard-d5: one stamp of 64 by 64 pixels with its flags
- SPHEREx frame level2_2026W11_2A_0501_3D5_spx_l2b-v27-2026-234.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2026W11_2A/l2b-v27-2026-234/5/level2_2026W11_2A_0501_3D5_spx_l2b-v27-2026-234.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/showcase/barnard-d5: one stamp of 64 by 64 pixels with its flags
- SPHEREx frame level2_2026W11_2A_0550_1D5_spx_l2b-v27-2026-234.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2026W11_2A/l2b-v27-2026-234/5/level2_2026W11_2A_0550_1D5_spx_l2b-v27-2026-234.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/showcase/barnard-d5: one stamp of 64 by 64 pixels with its flags
- SPHEREx frame level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W35_1A/l2b-v27-2026-230/1/level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits | Public, no usage restrictions (IRSA terms of use) | the wavelength table of detector 1 in tests/fixtures/wave/tables.json and site/data/wave/tables.json
- SPHEREx frame level2_2025W34_2B_0090_4D2_spx_l2b-v27-2026-229.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W34_2B/l2b-v27-2026-229/2/level2_2025W34_2B_0090_4D2_spx_l2b-v27-2026-229.fits | Public, no usage restrictions (IRSA terms of use) | the wavelength table of detector 2 in tests/fixtures/wave/tables.json and site/data/wave/tables.json
- SPHEREx frame level2_2025W33_2C_0321_1D3_spx_l2b-v27-2026-228.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W33_2C/l2b-v27-2026-228/3/level2_2025W33_2C_0321_1D3_spx_l2b-v27-2026-228.fits | Public, no usage restrictions (IRSA terms of use) | the wavelength table of detector 3 in tests/fixtures/wave/tables.json and site/data/wave/tables.json
- SPHEREx frame level2_2025W35_1A_0432_4D4_spx_l2b-v27-2026-230.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W35_1A/l2b-v27-2026-230/4/level2_2025W35_1A_0432_4D4_spx_l2b-v27-2026-230.fits | Public, no usage restrictions (IRSA terms of use) | the wavelength table of detector 4 in tests/fixtures/wave/tables.json and site/data/wave/tables.json
- SPHEREx frame level2_2025W34_2B_0090_4D5_spx_l2b-v27-2026-229.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W34_2B/l2b-v27-2026-229/5/level2_2025W34_2B_0090_4D5_spx_l2b-v27-2026-229.fits | Public, no usage restrictions (IRSA terms of use) | the wavelength table of detector 5 in tests/fixtures/wave/tables.json and site/data/wave/tables.json
- SPHEREx frame level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits | Public, no usage restrictions (IRSA terms of use) | the wavelength table of detector 6 in tests/fixtures/wave/tables.json and site/data/wave/tables.json
- SPHEREx frame level2_2025W40_1A_0441_1D1_spx_l2b-v27-2026-239.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W40_1A/l2b-v27-2026-239/1/level2_2025W40_1A_0441_1D1_spx_l2b-v27-2026-239.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/wave/reference.json: wavelength and bandwidth at 200 pixels of detector 1
- SPHEREx frame level2_2025W40_1A_0529_4D2_spx_l2b-v27-2026-239.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W40_1A/l2b-v27-2026-239/2/level2_2025W40_1A_0529_4D2_spx_l2b-v27-2026-239.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/wave/reference.json: wavelength and bandwidth at 200 pixels of detector 2
- SPHEREx frame level2_2026W12_1A_0598_4D3_spx_l2b-v27-2026-235.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2026W12_1A/l2b-v27-2026-235/3/level2_2026W12_1A_0598_4D3_spx_l2b-v27-2026-235.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/wave/reference.json: wavelength and bandwidth at 200 pixels of detector 3
- SPHEREx frame level2_2025W40_1A_0067_1D6_spx_l2b-v27-2026-239.fits | https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W40_1A/l2b-v27-2026-239/6/level2_2025W40_1A_0067_1D6_spx_l2b-v27-2026-239.fits | Public, no usage restrictions (IRSA terms of use) | tests/fixtures/wave/reference.json: wavelength and bandwidth at 200 pixels of detector 6

## Libraries

- TypeScript | https://www.typescriptlang.org/ | Apache-2.0 | the type check of site/js; used in development only
- Playwright | https://playwright.dev/ | Apache-2.0 | the browser tests; used in development only
- Astropy | https://www.astropy.org/ | BSD-3-Clause | the reference values of the fixtures; reading frames in the pipeline
- NumPy | https://numpy.org/ | BSD-3-Clause | arrays in the pipeline and in its tests
- SciPy | https://scipy.org/ | BSD-3-Clause | part of the pipeline environment
- Matplotlib | https://matplotlib.org/ | Matplotlib licence (based on the Python Software Foundation licence) | part of the pipeline environment
- Requests | https://requests.readthedocs.io/ | Apache-2.0 | downloading whole frames for the reference values of the fixtures
- pytest | https://docs.pytest.org/ | MIT | the tests of the pipeline

## Tools and services

- Node.js | https://nodejs.org/ | MIT | runs the unit tests, the gate and the development server
- npm | https://github.com/npm/cli | Artistic-2.0 | installs the two development dependencies
- Python | https://www.python.org/ | PSF-2.0 | runs the pipeline and its tests
- Git | https://git-scm.com/ | GPL-2.0-only | version control
- Chromium, as Chrome for Testing | https://www.chromium.org/ | BSD-3-Clause | the browser that the browser tests run in
- GitHub Actions: actions/checkout | https://github.com/actions/checkout | MIT | the check and deployment workflows
- GitHub Actions: actions/setup-node | https://github.com/actions/setup-node | MIT | the check and deployment workflows
- GitHub Actions: actions/setup-python | https://github.com/actions/setup-python | MIT | the check workflow
- GitHub Actions: actions/configure-pages | https://github.com/actions/configure-pages | MIT | the deployment workflow
- GitHub Actions: actions/upload-pages-artifact | https://github.com/actions/upload-pages-artifact | MIT | the deployment workflow
- GitHub Actions: actions/deploy-pages | https://github.com/actions/deploy-pages | MIT | the deployment workflow
- GitHub Pages | https://pages.github.com/ | Service under the GitHub Terms of Service | where the deployment workflow publishes the site

## Text sources

- Apache License, Version 2.0 | https://www.apache.org/licenses/LICENSE-2.0.txt | Copied word for word, as the licence is meant to be | the LICENSE file
- Definition of the Flexible Image Transport System (FITS), the FITS Standard | https://fits.gsfc.nasa.gov/fits_standard.html | Freely available | how the bytes of a frame are laid out, in tests/fixtures/README.md and in the fixture tests
- JSON Schema, draft 2020-12 | https://json-schema.org/draft/2020-12 | Freely available | the words used by the schemas in tests/vectors/schema
