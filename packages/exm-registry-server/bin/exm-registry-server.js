#!/usr/bin/env node
/* eslint-disable n/no-unpublished-import */
import { main } from '../lib/cli.js';

process.exitCode = await main();
