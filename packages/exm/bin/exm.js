#!/usr/bin/env node
/* eslint-disable n/no-unpublished-import */
import { main } from '../lib/cli.js';
import process from 'node:process';

process.exitCode = await main();
