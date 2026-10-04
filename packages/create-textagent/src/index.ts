#!/usr/bin/env node
// `npm create textagent [dir] [flags]` runs this; it is `textagent create` under another name.
import { main } from 'textagent';

process.exitCode = await main(['create', ...process.argv.slice(2)]);
