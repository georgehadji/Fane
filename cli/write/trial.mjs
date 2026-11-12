import { readFile } from 'node:fs/promises';

// The models that passed the trial (trial.json `models`). No file yet is an empty trial, which the hooks and the CLI
// answer with "no model has passed"; a corrupt or unreadable file must surface, not read as an empty trial.
export async function readTrial(file, read = readFile) {
  try {
    return JSON.parse(await read(file, 'utf8')).models || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`could not read the model trial (${err.message})`, { cause: err });
  }
}
