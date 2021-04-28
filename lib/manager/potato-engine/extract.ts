import is from '@sindresorhus/is';
import yaml from 'js-yaml';
import * as datasourceNuget from '../../datasource/nuget';
import { logger } from '../../logger';
import { getConfiguredRegistries } from '../nuget/util';
import { ExtractConfig, PackageDependency, PackageFile } from '../types';

export async function extractPackageFile(
  content: string,
  packageFile: string,
  config: ExtractConfig
): Promise<PackageFile> | null {
  logger.trace('potato-engine.extractPackageFile()');
  let doc;
  try {
    doc = yaml.safeLoad(content, { json: true });
  } catch (err) {
    logger.warn(
      { err, content, ileName: packageFile },
      'Failed to parse file.'
    );
    return null;
  }
  if (doc.custom_job === undefined) {
    return null;
  }
  // Registry stuff borrowed from nuget
  const registries = await getConfiguredRegistries(
    packageFile,
    config.localDir
  );
  const registryUrls = registries
    ? registries.map((registry) => registry.url)
    : undefined;
  const deps: PackageDependency[] = [];
  if (is.array(doc.packages)) {
    for (const d of doc.packages) {
      const dep: PackageDependency = {
        depType: 'nuget',
        depName: d.id,
        currentValue: d.version,
        datasource: datasourceNuget.id,
      };
      if (registryUrls) {
        dep.registryUrls = registryUrls;
      }
      deps.push(dep);
    }
  }
  if (!deps.length) {
    return null;
  }
  return { deps };
}
