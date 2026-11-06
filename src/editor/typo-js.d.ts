declare module "typo-js" {
  export default class Typo {
    constructor(locale: string, aff: string, dic: string);
    check(word: string): boolean;
    suggest(word: string): string[];
  }
}
