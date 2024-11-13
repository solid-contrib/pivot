import { promises } from 'node:fs';

export async function debug(str: string): Promise<void> {
  console.log(`DEBUG: ${str}`);
  await promises.appendFile('debug.txt', `${str}\n`);
}
