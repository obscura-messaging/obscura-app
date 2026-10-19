import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';

const source = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');
const sorted = (names: Iterable<string>) => [...names].sort();
const contract = ts.createSourceFile('ObscuraModule.ts', source('src/native/ObscuraModule.ts'), ts.ScriptTarget.Latest);

const methods = contract.statements
  .filter(ts.isInterfaceDeclaration)
  .find((declaration) => declaration.name.text === 'ObscuraBridge')!
  .members.filter(ts.isMethodSignature)
  .map((method) => method.name.getText(contract));

const android = source('android/app/src/main/java/dev/barrelmaker/obscura/ObscuraBridgeModule.kt');
const swift = source('ios/Obscura/ObscuraBridge.swift');
const objc = source('ios/Obscura/ObscuraBridge.m');

describe('native exports match the bridge contract', () => {
  it('exports exactly the TypeScript methods on Android', () => {
    const exported = [...android.matchAll(/@ReactMethod\s+fun\s+(\w+)/g)]
      .map((match) => match[1])
      .filter((name) => name !== 'addListener' && name !== 'removeListeners');
    expect(sorted(exported)).toEqual(sorted(methods));
  });

  it('exports every Swift selector through Objective-C, with no obsolete methods', () => {
    const declared = [...objc.matchAll(/RCT_EXTERN_METHOD\((\w+)/g)].map((match) => match[1]);
    const implemented = [...swift.matchAll(/@objc\((\w+):/g)].map((match) => match[1]);
    expect(sorted(declared)).toEqual(sorted(methods));
    expect(sorted(implemented)).toEqual(sorted(methods));
  });

  it('preserves the same deliberate error codes from both kits', () => {
    const declaration = contract.statements.filter(ts.isTypeAliasDeclaration)
      .find((alias) => alias.name.text === 'ObscuraErrorCode')!;
    if (!ts.isUnionTypeNode(declaration.type)) throw new Error('Expected an error-code union');
    const codes = declaration.type.types.map((type) => {
      if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) {
        throw new Error('Expected a string error code');
      }
      return type.literal.text;
    });
    const kotlin = source('obscura-native/kotlin/lib/src/main/kotlin/dev/barrelmaker/obscura/kit/ObscuraError.kt');
    const swiftErrors = source('obscura-native/swift/Sources/ObscuraKit/ObscuraError.swift');
    expect(sorted([...kotlin.matchAll(/ObscuraError\(\s*"([A-Z_]+)"/g)].map((match) => match[1])))
      .toEqual(sorted(codes));
    expect(sorted([...swiftErrors.matchAll(/return "([A-Z_]+)"/g)].map((match) => match[1])))
      .toEqual(sorted(codes));
  });
});
