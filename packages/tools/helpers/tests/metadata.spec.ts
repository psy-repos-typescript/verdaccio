import { addNewVersion, generatePackageMetadata } from '../src';

describe('generate metadata', () => {
  test('should generate package metadata', () => {
    expect(generatePackageMetadata('foo', '1.0.0')).toBeDefined();
  });

  test('should match versions', () => {
    const manifest = generatePackageMetadata('foo', '1.0.0');
    expect(Object.keys(manifest.versions)).toEqual(['1.0.0']);
  });

  test('should add new versions', () => {
    const manifest = generatePackageMetadata('foo', '1.0.0');
    expect(Object.keys(addNewVersion(manifest, '1.0.1').versions)).toEqual(['1.0.0', '1.0.1']);
    const m = addNewVersion(manifest, '1.0.2');
    expect(Object.keys(m.versions)).toEqual(['1.0.0', '1.0.1', '1.0.2']);
    expect(m['dist-tags'].latest).toEqual('1.0.2');
  });

  test('should fails add repeated version', () => {
    const manifest = generatePackageMetadata('foo', '1.0.0');
    expect(() => Object.keys(addNewVersion(manifest, '1.0.0').versions)).toThrow();
  });
});
