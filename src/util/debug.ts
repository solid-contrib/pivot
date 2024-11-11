import { promises } from 'node:fs';

export async function debug(str: string): Promise<void> {
  // await promises.appendFile('debug.txt', `${str}\n`);
}
