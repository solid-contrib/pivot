import { appendFile } from 'node:fs';

export function debug(str: string): void {
  appendFile('~/debug.txt', `${str}\n`, (): void => {});
}
