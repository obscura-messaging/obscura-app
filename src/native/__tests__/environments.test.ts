import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Each platform declares the dev and prod apps in its own native format: Android product flavors,
 * iOS xcconfig and export options, and the distribution workflows. This table is the one statement
 * of what those apps are, and every native declaration must agree with it.
 */
const environments = {
  dev: {
    appId: 'dev.barrelmaker.obscura.dev',
    name: 'Obscura Dev',
    host: 'devscura.barrelmaker.dev',
    profile: 'Obscura Dev App Store',
    internalTestingOnly: true,
  },
  prod: {
    appId: 'dev.barrelmaker.obscura',
    name: 'Obscura',
    host: 'obscura.barrelmaker.dev',
    profile: 'Obscura App Store',
    internalTestingOnly: false,
  },
};
type Env = keyof typeof environments;
const envs = Object.keys(environments) as Env[];
const fileName = (env: Env) => env[0].toUpperCase() + env.slice(1);

const source = (path: string) =>
  readFileSync(resolve(__dirname, '../../..', path), 'utf8');

const match = (text: string, pattern: RegExp, what: string) => {
  const found = text.match(pattern);
  if (!found) {
    throw new Error(`missing ${what}`);
  }
  return found[1];
};

describe('dev and prod environments', () => {
  describe('Android product flavors', () => {
    const gradle = source('android/app/build.gradle');
    const baseId = match(
      gradle,
      /defaultConfig \{[^}]*applicationId "([^"]+)"/,
      'defaultConfig applicationId',
    );
    const flavor = (env: Env) =>
      match(gradle, new RegExp(`\\n\\s+${env} \\{([^}]*)\\}`), `${env} flavor`);

    it.each(envs)('%s has the expected app id, name and server', env => {
      const block = flavor(env);
      const suffix = block.match(/applicationIdSuffix "([^"]+)"/)?.[1] ?? '';
      expect(baseId + suffix).toBe(environments[env].appId);
      expect(match(block, /"app_name", "([^"]+)"/, 'app_name')).toBe(
        environments[env].name,
      );
      expect(
        match(block, /"OBSCURA_API_URL", '"([^"]+)"'/, 'OBSCURA_API_URL'),
      ).toBe(`https://${environments[env].host}`);
    });

    it('ships a compile-only Firebase stub that covers every app id', () => {
      const stub = JSON.parse(source('android/app/google-services.stub.json'));
      const packages = stub.client.map(
        (client: {
          client_info: { android_client_info: { package_name: string } };
        }) => client.client_info.android_client_info.package_name,
      );
      expect(packages.sort()).toEqual(
        envs.map(env => environments[env].appId).sort(),
      );
    });
  });

  describe('iOS build settings', () => {
    const xcconfig = (env: Env) =>
      Object.fromEntries(
        source(`ios/Config/${fileName(env)}.xcconfig`)
          .split('\n')
          .filter(line => line.includes(' = ') && !line.startsWith('//'))
          .map(line => [
            line.slice(0, line.indexOf(' = ')),
            line.slice(line.indexOf(' = ') + 3),
          ]),
      );

    it.each(envs)(
      '%s.xcconfig has the expected bundle id, name, server and profile',
      env => {
        expect(xcconfig(env)).toEqual({
          PRODUCT_BUNDLE_IDENTIFIER: environments[env].appId,
          OBSCURA_DISPLAY_NAME: environments[env].name,
          OBSCURA_API_HOST: environments[env].host,
          'PROVISIONING_PROFILE_SPECIFIER[config=Release][sdk=iphoneos*]':
            environments[env].profile,
        });
      },
    );

    it.each(envs)(
      '%s export options sign with its profile and restrict TestFlight as expected',
      env => {
        const plist = source(`ios/Config/${fileName(env)}-ExportOptions.plist`);
        const profiles = match(
          plist,
          /<key>provisioningProfiles<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
          'profiles',
        );
        expect(
          [
            ...profiles.matchAll(
              /<key>([^<]+)<\/key>\s*<string>([^<]+)<\/string>/g,
            ),
          ].map(m => [m[1], m[2]]),
        ).toEqual([[environments[env].appId, environments[env].profile]]);
        expect(
          match(
            plist,
            /<key>testFlightInternalTestingOnly<\/key>\s*<(true|false)\/>/,
            'TestFlight flag',
          ),
        ).toBe(String(environments[env].internalTestingOnly));
      },
    );

    it('leaves environment settings to the xcconfig files', () => {
      // A target-level value would silently override the xcconfig for every build.
      const project = source('ios/Obscura.xcodeproj/project.pbxproj');
      for (const key of [
        'PRODUCT_BUNDLE_IDENTIFIER',
        'OBSCURA_DISPLAY_NAME',
        'OBSCURA_API_HOST',
        'PROVISIONING_PROFILE_SPECIFIER',
      ]) {
        expect(project).not.toContain(`${key} =`);
      }
    });
  });

  describe('distribution workflows', () => {
    it.each([
      ['.github/workflows/distribute-android.yml', 'ANDROID_PACKAGE_NAME'],
      ['.github/workflows/distribute-ios.yml', 'APPLE_BUNDLE_ID'],
    ])('%s maps each env to its app id', (path, variable) => {
      const workflow = source(path);
      const mappings = [
        ...workflow.matchAll(
          new RegExp(
            `${variable}: \\$\\{\\{ inputs\\.env == 'prod' && '([^']+)' \\|\\| '([^']+)' \\}\\}`,
            'g',
          ),
        ),
      ];
      expect(mappings.length).toBeGreaterThan(0);
      for (const [, prod, dev] of mappings) {
        expect({ prod, dev }).toEqual({
          prod: environments.prod.appId,
          dev: environments.dev.appId,
        });
      }
    });
  });
});

describe('Gradle builds', () => {
  it('run the app and the Kotlin kit on the same Gradle version', () => {
    const distribution = (path: string) =>
      match(source(path), /distributionUrl=(\S+)/, `${path} distributionUrl`);
    expect(
      distribution('kotlin/gradle/wrapper/gradle-wrapper.properties'),
    ).toBe(distribution('android/gradle/wrapper/gradle-wrapper.properties'));
  });
});
