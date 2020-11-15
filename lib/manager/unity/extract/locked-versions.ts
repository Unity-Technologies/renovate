import { valid } from 'semver';
import { logger } from '../../../logger';
import { PackageFile } from '../../common';
import { LockFile } from './common';
import { getNpmLock } from './npm';

export async function getLockedVersions(
  packageFiles: PackageFile[]
): Promise<void> {
  const lockFileCache: Record<string, LockFile> = {};
  logger.debug('Finding locked versions');
  for (const packageFile of packageFiles) {
    const { npmLock, pnpmShrinkwrap } = packageFile;
    if (npmLock) {
      logger.debug('Found ' + npmLock + ' for ' + packageFile.packageFile);
      if (!lockFileCache[npmLock]) {
        logger.trace('Retrieving/parsing ' + npmLock);
        lockFileCache[npmLock] = await getNpmLock(npmLock);
      }
      if (!packageFile.constraints.npm) {
        // do not override if already set
        const { lockfileVersion } = lockFileCache[npmLock];
        if (lockfileVersion >= 2) {
          packageFile.constraints.npm = '>= 7.0.0';
        }
      }
      for (const dep of packageFile.deps) {
        dep.lockedVersion = valid(
          lockFileCache[npmLock].lockedVersions[dep.depName]
        );
      }
    } else if (pnpmShrinkwrap) {
      logger.debug('TODO: implement pnpm-lock.yaml parsing of lockVersion');
    }
  }
}
