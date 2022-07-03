import nock from 'nock';
import * as httpMocks from 'node-mocks-http';
import path from 'path';

import { Config } from '@verdaccio/config';
import { API_ERROR, DIST_TAGS, HEADERS, HEADER_TYPE, errorUtils } from '@verdaccio/core';
import { setup } from '@verdaccio/logger';
import { configExample, generateRamdonStorage } from '@verdaccio/mock';
import {
  addNewVersion,
  generatePackageMetadata,
  generatePublishNewVersionManifest,
} from '@verdaccio/test-helper';
import { Manifest } from '@verdaccio/types';

import { Storage } from '../src';
import manifestFooRemoteNpmjs from './fixtures/manifests/foo-npmjs.json';
import { addPackageToStore } from './helpers';

// import manifestFooRemoteVerdaccio from './fixtures/manifests/foo-verdaccio.json';

setup({ type: 'stdout', format: 'pretty', level: 'trace' });

const domain = 'http://localhost:4873';
const fakeHost = 'localhost:4873';
const fooManifest = generatePackageMetadata('foo', '1.0.0');

describe('storage', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.abortPendingRequests();
    jest.clearAllMocks();
  });

  describe('add packages', () => {
    test('add package item', async () => {
      nock(domain).get('/foo').reply(404);
      const config = new Config(
        configExample({
          storage: generateRamdonStorage(),
        })
      );
      const storage = new Storage(config);
      await storage.init(config);

      await storage.addPackage('foo', fooManifest, (err) => {
        expect(err).toBeNull();
      });
    });
  });

  describe('getTarballNext', () => {
    //  nock('https://registry.verdaccio.org').get('/foo').reply(201, manifestFooRemoteNpmjs);

    test('should not found a package anywhere', (done) => {
      const config = new Config(
        configExample({
          storage: generateRamdonStorage(),
        })
      );
      const storage = new Storage(config);
      storage.init(config).then(() => {
        const abort = new AbortController();
        storage
          .getTarballNext('some-tarball', 'some-tarball-1.0.0.tgz', {
            signal: abort.signal,
          })
          .then((stream) => {
            stream.on('error', (err) => {
              expect(err).toEqual(errorUtils.getNotFound(API_ERROR.NO_PACKAGE));
              done();
            });
          });
      });
    });

    test.only('should fails local and get from upstream', (done) => {
      const pkgName = 'upstream';
      const upstreamManifest = addNewVersion(generatePackageMetadata(pkgName, '1.0.0'), '1.0.1');
      nock('https://registry.verdaccio.org').get('/upstream').reply(201, upstreamManifest);
      nock('http://localhost:5555')
        .get(`/${pkgName}/-/${pkgName}-1.0.1.tgz`)
        // types does not match here with documentation
        // @ts-expect-error
        .replyWithFile(201, path.join(__dirname, 'fixtures/tarball.tgz'), {
          [HEADER_TYPE.CONTENT_LENGTH]: 0,
        });
      const config = new Config(
        configExample(
          {
            storage: generateRamdonStorage(),
          },
          './fixtures/config/getTarballNext-getupstream.yaml',
          __dirname
        )
      );
      const storage = new Storage(config);
      storage.init(config).then(() => {
        const ac = new AbortController();
        const bodyNewManifest = generatePackageMetadata(pkgName, '1.0.0');
        storage
          .updateManifest(bodyNewManifest, {
            signal: ac.signal,
            name: pkgName,
            uplinksLook: true,
            revision: '1',
            requestOptions: {
              host: 'localhost',
              protocol: 'http',
              headers: {},
            },
          })
          .then(() => {
            const abort = new AbortController();
            storage
              .getTarballNext(pkgName, `${pkgName}-1.0.1.tgz`, {
                signal: abort.signal,
              })
              .then((stream) => {
                stream.on('data', (dat) => {
                  expect(dat).toBeDefined();
                });
                stream.on('end', () => {
                  done();
                });
                stream.on('error', (er) => {
                  console.log('err', er);
                  done('this should not happen');
                });
              });
          });
      });
    });
  });

  describe('syncUplinksMetadataNext()', () => {
    describe('error handling', () => {
      test('should handle double failure on uplinks with timeout', async () => {
        const fooManifest = generatePackageMetadata('timeout', '8.0.0');

        nock('https://registry.domain.com')
          .get('/timeout')
          .times(10)
          .delayConnection(2000)
          .reply(201, manifestFooRemoteNpmjs);

        const config = new Config(
          configExample(
            {
              storage: generateRamdonStorage(),
            },
            './fixtures/config/syncDoubleUplinksMetadata.yaml',
            __dirname
          )
        );

        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.syncUplinksMetadataNext(fooManifest.name, null, {
            retry: { limit: 0 },
            timeout: {
              lookup: 100,
              connect: 50,
              secureConnect: 50,
              socket: 500,
              // send: 10000,
              response: 1000,
            },
          })
        ).rejects.toThrow('ETIMEDOUT');
      }, 10000);

      test('should handle one proxy fails', async () => {
        const fooManifest = generatePackageMetadata('foo', '8.0.0');
        nock('https://registry.verdaccio.org').get('/foo').replyWithError('service in holidays');
        const config = new Config(
          configExample(
            {
              storage: generateRamdonStorage(),
            },
            './fixtures/config/syncSingleUplinksMetadata.yaml',
            __dirname
          )
        );
        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.syncUplinksMetadataNext(fooManifest.name, fooManifest, {
            retry: { limit: 0 },
          })
        ).rejects.toThrow(API_ERROR.NO_PACKAGE);
      });

      test('should handle one proxy reply 304', async () => {
        const fooManifest = generatePackageMetadata('foo-no-data', '8.0.0');
        nock('https://registry.verdaccio.org').get('/foo-no-data').reply(304);
        const config = new Config(
          configExample(
            {
              storage: generateRamdonStorage(),
            },
            './fixtures/config/syncSingleUplinksMetadata.yaml',
            __dirname
          )
        );
        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.syncUplinksMetadataNext(fooManifest.name, fooManifest, {
            retry: 0,
          })
        ).rejects.toThrow(API_ERROR.NOT_MODIFIED_NO_DATA);
      });
    });

    describe('success scenarios', () => {
      test('should handle one proxy success', async () => {
        const fooManifest = generatePackageMetadata('foo', '8.0.0');
        nock('https://registry.verdaccio.org').get('/foo').reply(201, manifestFooRemoteNpmjs);
        const config = new Config(
          configExample(
            {
              storage: generateRamdonStorage(),
            },
            './fixtures/config/syncSingleUplinksMetadata.yaml',
            __dirname
          )
        );
        const storage = new Storage(config);
        await storage.init(config);

        const [response] = await storage.syncUplinksMetadataNext(fooManifest.name, fooManifest);
        expect(response).not.toBeNull();
        expect((response as Manifest).name).toEqual(fooManifest.name);
        expect((response as Manifest)[DIST_TAGS].latest).toEqual('8.0.0');
      });

      test('should handle one proxy success with no local cache manifest', async () => {
        nock('https://registry.verdaccio.org').get('/foo').reply(201, manifestFooRemoteNpmjs);
        const config = new Config(
          configExample(
            {
              storage: generateRamdonStorage(),
            },
            './fixtures/config/syncSingleUplinksMetadata.yaml',
            __dirname
          )
        );
        const storage = new Storage(config);
        await storage.init(config);

        const [response] = await storage.syncUplinksMetadataNext(fooManifest.name, null);
        // the latest from the remote manifest
        expect(response).not.toBeNull();
        expect((response as Manifest).name).toEqual(fooManifest.name);
        expect((response as Manifest)[DIST_TAGS].latest).toEqual('0.0.7');
      });

      test('should handle no proxy found with local cache manifest', async () => {
        const fooManifest = generatePackageMetadata('foo', '8.0.0');
        nock('https://registry.verdaccio.org').get('/foo').reply(201, manifestFooRemoteNpmjs);
        const config = new Config(
          configExample(
            {
              storage: generateRamdonStorage(),
            },
            './fixtures/config/syncNoUplinksMetadata.yaml',
            __dirname
          )
        );
        const storage = new Storage(config);
        await storage.init(config);

        const [response] = await storage.syncUplinksMetadataNext(fooManifest.name, fooManifest);
        expect(response).not.toBeNull();
        expect((response as Manifest).name).toEqual(fooManifest.name);
        expect((response as Manifest)[DIST_TAGS].latest).toEqual('8.0.0');
      });
      test.todo('should handle double proxy with last one success');
    });
    describe('options', () => {
      test('should handle disable uplinks via options.uplinksLook=false', async () => {
        const fooManifest = generatePackageMetadata('foo', '8.0.0');
        nock('https://registry.verdaccio.org').get('/foo').reply(201, manifestFooRemoteNpmjs);
        const config = new Config(
          configExample(
            {
              storage: generateRamdonStorage(),
            },
            './fixtures/config/syncSingleUplinksMetadata.yaml',
            __dirname
          )
        );
        const storage = new Storage(config);
        await storage.init(config);

        const [response] = await storage.syncUplinksMetadataNext(fooManifest.name, fooManifest, {
          uplinksLook: false,
        });

        expect((response as Manifest).name).toEqual(fooManifest.name);
        expect((response as Manifest)[DIST_TAGS].latest).toEqual('8.0.0');
      });
    });
  });

  // TODO: getPackageNext should replace getPackage eventually
  describe('get packages getPackageByOptions()', () => {
    describe('with uplinks', () => {
      test('should get 201 and merge from uplink', async () => {
        nock(domain).get('/foo').reply(201, fooManifest);
        const config = new Config(
          configExample({
            storage: generateRamdonStorage(),
          })
        );
        const req = httpMocks.createRequest({
          method: 'GET',
          connection: { remoteAddress: fakeHost },
          headers: {
            host: fakeHost,
            [HEADERS.FORWARDED_PROTO]: 'http',
          },
          url: '/',
        });
        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.getPackageByOptions({
            name: 'foo',
            uplinksLook: true,
            requestOptions: {
              headers: req.headers as any,
              protocol: req.protocol,
              host: req.get('host') as string,
            },
          })
        ).resolves.toEqual(expect.objectContaining({ name: 'foo' }));
      });

      test('should get 201 and merge from uplink with version', async () => {
        nock(domain).get('/foo').reply(201, fooManifest);
        const config = new Config(
          configExample({
            storage: generateRamdonStorage(),
          })
        );
        const req = httpMocks.createRequest({
          method: 'GET',
          connection: { remoteAddress: fakeHost },
          headers: {
            host: fakeHost,
            [HEADERS.FORWARDED_PROTO]: 'http',
          },
          url: '/',
        });
        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.getPackageByOptions({
            name: 'foo',
            version: '1.0.0',
            uplinksLook: true,
            requestOptions: {
              headers: req.headers as any,
              protocol: req.protocol,
              host: req.get('host') as string,
            },
          })
        ).resolves.toEqual(expect.objectContaining({ name: 'foo' }));
      });

      test('should get 201 and merge from uplink with dist-tag', async () => {
        nock(domain).get('/foo').reply(201, fooManifest);
        const config = new Config(
          configExample({
            storage: generateRamdonStorage(),
          })
        );
        const req = httpMocks.createRequest({
          method: 'GET',
          connection: { remoteAddress: fakeHost },
          headers: {
            host: fakeHost,
            [HEADERS.FORWARDED_PROTO]: 'http',
          },
          url: '/',
        });
        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.getPackageByOptions({
            name: 'foo',
            version: 'latest',
            uplinksLook: true,
            requestOptions: {
              headers: req.headers as any,
              protocol: req.protocol,
              host: req.get('host') as string,
            },
          })
        ).resolves.toEqual(expect.objectContaining({ name: 'foo' }));
      });

      test('should get 404 for version does not exist', async () => {
        nock(domain).get('/foo').reply(201, fooManifest);
        const config = new Config(
          configExample({
            storage: generateRamdonStorage(),
          })
        );
        const req = httpMocks.createRequest({
          method: 'GET',
          connection: { remoteAddress: fakeHost },
          headers: {
            host: fakeHost,
            [HEADERS.FORWARDED_PROTO]: 'http',
          },
          url: '/',
        });
        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.getPackageByOptions({
            name: 'foo',
            version: '1.0.0-does-not-exist',
            uplinksLook: true,
            requestOptions: {
              headers: req.headers as any,
              protocol: req.protocol,
              host: req.get('host') as string,
            },
          })
        ).rejects.toThrow(
          errorUtils.getNotFound("this version doesn't exist: 1.0.0-does-not-exist")
        );
      });

      test('should get 404', async () => {
        nock(domain).get('/foo2').reply(404);
        const config = new Config(
          configExample({
            storage: generateRamdonStorage(),
          })
        );
        const req = httpMocks.createRequest({
          method: 'GET',
          connection: { remoteAddress: fakeHost },
          headers: {
            host: fakeHost,
            [HEADERS.FORWARDED_PROTO]: 'http',
          },
          url: '/',
        });
        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.getPackageByOptions({
            name: 'foo2',
            uplinksLook: true,
            requestOptions: {
              headers: req.headers as any,
              protocol: req.protocol,
              host: req.get('host') as string,
            },
          })
        ).rejects.toThrow(errorUtils.getNotFound());
      });

      test('should get ETIMEDOUT with uplink', async () => {
        nock(domain).get('/foo2').replyWithError({
          code: 'ETIMEDOUT',
          errno: 'ETIMEDOUT',
        });
        const config = new Config(
          configExample({
            storage: generateRamdonStorage(),
          })
        );
        const req = httpMocks.createRequest({
          method: 'GET',
          connection: { remoteAddress: fakeHost },
          headers: {
            host: fakeHost,
            [HEADERS.FORWARDED_PROTO]: 'http',
          },
          url: '/',
        });
        const storage = new Storage(config);
        await storage.init(config);
        await expect(
          storage.getPackageByOptions({
            name: 'foo2',
            uplinksLook: true,
            retry: { limit: 0 },
            requestOptions: {
              headers: req.headers as any,
              protocol: req.protocol,
              host: req.get('host') as string,
            },
          })
        ).rejects.toThrow(errorUtils.getServiceUnavailable('ETIMEDOUT'));
      });
    });
  });
});
