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
});
