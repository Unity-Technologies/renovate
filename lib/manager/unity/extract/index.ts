import validateNpmPackageName from 'validate-npm-package-name';
import * as datasourceGithubTags from '../../../datasource/github-tags';
import * as datasourceNpm from '../../../datasource/npm';
import { logger } from '../../../logger';
import { SkipReason } from '../../../types';
import { getSiblingFileName, readLocalFile } from '../../../util/fs';
import { isValid, isVersion } from '../../../versioning/npm';
import { ExtractConfig, PackageDependency, PackageFile } from '../../common';
import { UpmLockFiles, UpmPackage, UpmPackageDependency } from './common';
import { getLockedVersions } from './locked-versions';
import { detectMonorepos } from './monorepo';

function parseDepName(depType: string, key: string): string {
  if (depType !== 'resolutions') {
    return key;
  }

  const [, depName] = /((?:@[^/]+\/)?[^/@]+)$/.exec(key);
  return depName;
}

export async function extractPackageFile(
  content: string,
  fileName: string,
  config: ExtractConfig
): Promise<PackageFile | null> {
  logger.trace(`npm.extractPackageFile(${fileName})`);
  logger.trace({ content });
  const deps: PackageDependency[] = [];
  let manifestJson: UpmPackage;
  try {
    manifestJson = JSON.parse(content);
  } catch (err) {
    logger.debug({ fileName }, 'Invalid JSON');
    return null;
  }

  let lockFiles: UpmLockFiles = {
    packagesLock: 'packages-lock.json',
    projectVersion: '../Library/ProjectVersion.txt',
  };

  for (const [key, val] of Object.entries(lockFiles)) {
    const filePath = getSiblingFileName(fileName, val);
    if (await readLocalFile(filePath, 'utf8')) {
      lockFiles[key] = filePath;
    } else {
      lockFiles[key] = undefined;
    }
  }

  let hasFileRefs = false;

  const constraints: Record<string, any> = {};

  function extractDependency(
    depType: string,
    depName: string,
    input: string
  ): PackageDependency {
    const dep: PackageDependency = {};
    if (!validateNpmPackageName(depName).validForOldPackages) {
      dep.skipReason = SkipReason.InvalidName;
      return dep;
    }
    if (typeof input !== 'string') {
      dep.skipReason = SkipReason.InvalidValue;
      return dep;
    }
    dep.currentValue = input.trim();

    if (dep.currentValue.startsWith('npm:')) {
      dep.npmPackageAlias = true;
      const valSplit = dep.currentValue.replace('npm:', '').split('@');
      if (valSplit.length === 2) {
        dep.lookupName = valSplit[0];
        dep.currentValue = valSplit[1];
      } else if (valSplit.length === 3) {
        dep.lookupName = valSplit[0] + '@' + valSplit[1];
        dep.currentValue = valSplit[2];
      } else {
        logger.debug('Invalid npm package alias: ' + dep.currentValue);
      }
    }
    if (dep.currentValue.startsWith('file:')) {
      dep.skipReason = SkipReason.File;
      hasFileRefs = true;
      return dep;
    }
    if (isValid(dep.currentValue)) {
      dep.datasource = datasourceNpm.id;
      if (dep.currentValue === '*') {
        dep.skipReason = SkipReason.AnyVersion;
      }
      if (dep.currentValue === '') {
        dep.skipReason = SkipReason.Empty;
      }
      return dep;
    }
    const hashSplit = dep.currentValue.split('#');
    if (hashSplit.length !== 2) {
      dep.skipReason = SkipReason.UnknownVersion;
      return dep;
    }
    const [depNamePart, depRefPart] = hashSplit;
    const githubOwnerRepo = depNamePart
      .replace(/^github:/, '')
      .replace(/^git\+/, '')
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '');
    const githubRepoSplit = githubOwnerRepo.split('/');
    if (githubRepoSplit.length !== 2) {
      dep.skipReason = SkipReason.UnknownVersion;
      return dep;
    }
    const [githubOwner, githubRepo] = githubRepoSplit;
    const githubValidRegex = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/;
    if (
      !githubValidRegex.test(githubOwner) ||
      !githubValidRegex.test(githubRepo)
    ) {
      dep.skipReason = SkipReason.UnknownVersion;
      return dep;
    }
    if (isVersion(depRefPart)) {
      dep.currentRawValue = dep.currentValue;
      dep.currentValue = depRefPart;
      dep.datasource = datasourceGithubTags.id;
      dep.lookupName = githubOwnerRepo;
      dep.pinDigests = false;
    } else if (
      /^[0-9a-f]{7}$/.test(depRefPart) ||
      /^[0-9a-f]{40}$/.test(depRefPart)
    ) {
      dep.currentRawValue = dep.currentValue;
      dep.currentValue = null;
      dep.currentDigest = depRefPart;
      dep.datasource = datasourceGithubTags.id;
      dep.lookupName = githubOwnerRepo;
    } else {
      dep.skipReason = SkipReason.UnversionedReference;
      return dep;
    }
    dep.githubRepo = githubOwnerRepo;
    dep.sourceUrl = `https://github.com/${githubOwnerRepo}`;
    dep.gitRef = true;
    return dep;
  }

  try {
    for (const [key, val] of Object.entries(
      manifestJson as UpmPackageDependency
    )) {
      const depName = key;
      const dep: PackageDependency = {
        depName,
      };
      if (depName !== key) {
        dep.managerData = { key };
      }
      Object.assign(dep, extractDependency(depType, depName, val));
      if (depName === 'node') {
        // This is a special case for Node.js to group it together with other managers
        dep.commitMessageTopic = 'Node.js';
        dep.major = { enabled: false };
      }
      dep.prettyDepType = depTypes[depType];
      deps.push(dep);
    }
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ fileName, depType, err }, 'Error parsing package.json');
    return null;
  }

  if (deps.length === 0) {
    logger.debug('Package file has no deps');
    if (
      !(
        packageJsonName ||
        packageFileVersion ||
        npmrc ||
        lernaDir ||
        yarnWorkspacesPackages
      )
    ) {
      logger.debug('Skipping file');
      return null;
    }
  }
  let skipInstalls = config.skipInstalls;
  if (skipInstalls === null) {
    if (hasFileRefs) {
      // https://github.com/npm/cli/issues/1432
      // Explanation:
      //  - npm install --package-lock-only is buggy for transitive deps in file: references
      //  - So we set skipInstalls to false if file: refs are found *and* the user hasn't explicitly set the value already
      logger.debug('Automatically setting skipInstalls to false');
      skipInstalls = false;
    } else {
      skipInstalls = true;
    }
  }

  return {
    deps,
    packageJsonName,
    packageFileVersion,
    packageJsonType,
    npmrc,
    ignoreNpmrcFile,
    yarnrc,
    ...lockFiles,
    lernaDir,
    lernaClient,
    lernaPackages,
    skipInstalls,
    yarnWorkspacesPackages,
    constraints,
  };
}

export async function postExtract(packageFiles: PackageFile[]): Promise<void> {
  detectMonorepos(packageFiles);
  await getLockedVersions(packageFiles);
}

export async function extractAllPackageFiles(
  config: ExtractConfig,
  packageFiles: string[]
): Promise<PackageFile[]> {
  const npmFiles: PackageFile[] = [];
  for (const packageFile of packageFiles) {
    const content = await readLocalFile(packageFile, 'utf8');
    // istanbul ignore else
    if (content) {
      const deps = await extractPackageFile(content, packageFile, config);
      if (deps) {
        npmFiles.push({
          packageFile,
          ...deps,
        });
      }
    } else {
      logger.debug({ packageFile }, 'packageFile has no content');
    }
  }
  await postExtract(npmFiles);
  return npmFiles;
}
