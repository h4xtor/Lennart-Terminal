'use strict';

/**
 * Microsoft Store build (MSIX/APPX).
 *
 *   npm run store
 *
 * The Store signs the package itself, so users get NO SmartScreen warning.
 * The three identity values come from Partner Center → your app →
 * "Product identity". Put them in GitHub → Settings → Secrets and
 * variables → Actions → Variables (STORE_IDENTITY_NAME, STORE_PUBLISHER,
 * STORE_PUBLISHER_NAME) — or set them as environment variables locally.
 * Without them a test package with placeholder values is built (it proves
 * the packaging works, but cannot be uploaded).
 */

const base = require('./package.json').build;

const identityName = process.env.STORE_IDENTITY_NAME || 'LennartJensen.LennartTerminal';
const publisher = process.env.STORE_PUBLISHER || 'CN=00000000-0000-0000-0000-000000000000';
const publisherDisplayName = process.env.STORE_PUBLISHER_NAME || 'Lennart Jensen';

module.exports = {
  ...base,
  directories: { output: 'dist-store', buildResources: 'build' },
  win: {
    ...base.win,
    target: [{ target: 'appx', arch: ['x64'] }],
    artifactName: 'LennartTerminal-${version}-store.${ext}',
  },
  appx: {
    applicationId: 'LennartTerminal',
    identityName,
    publisher,
    publisherDisplayName,
    displayName: 'Lennart Terminal',
    backgroundColor: '#121317',
    showNameOnTiles: true,
    languages: ['da-DK', 'en-US'],
    // build/appx/*.png are used as the Store/Start-menu tiles
  },
};
