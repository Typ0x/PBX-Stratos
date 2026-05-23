// scripts/lib/platform.mjs
// Helper module imported lazily by scripts/setup.mjs on Windows when no
// system Python >= 3.10 is found and we need to bundle an embeddable
// Python distribution into .tooling/ without admin rights.
//
// Kept as its own file (rather than inlined) so it can be unit-tested
// in isolation and so the dynamic-import path in setup.mjs has
// something to resolve.

const PYTHON_VERSION = '3.12.7'; // pinned for reproducibility; bumping
                                 // this is a deliberate choice — must
                                 // re-check that the embed zip exists
                                 // for all archs at the new version.

/**
 * Returns a URL to download Python's official embeddable distribution
 * for the given CPU architecture. The embeddable zip is a self-contained
 * Python — extract it, get a working python.exe, no installer needed.
 *
 * @param {string} arch process.arch ('x64', 'arm64', or 'ia32')
 * @returns {string} HTTPS URL to a python-<ver>-embed-<arch>.zip
 * @throws {Error} if arch is unrecognized (rather than silently picking
 *                 a default — bootstrap should surface this clearly)
 */
export function pythonWinEmbedUrl(arch) {
  let archStr;
  switch (arch) {
    case 'arm64':
      archStr = 'arm64';
      break;
    case 'ia32':
      archStr = 'win32';
      break;
    case 'x64':
      archStr = 'amd64';
      break;
    default:
      throw new Error(
        `pythonWinEmbedUrl: unsupported arch '${arch}'. ` +
        `Supported: x64, arm64, ia32. Install Python manually from ` +
        `https://www.python.org/downloads/ and re-run.`
      );
  }
  return `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-${archStr}.zip`;
}

export { PYTHON_VERSION };
