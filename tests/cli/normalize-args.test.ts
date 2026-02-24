/**
 * CLI Argument Normalization Tests
 *
 * Verifies that --key=value syntax is correctly split into ['--key', 'value']
 * so the switch-based parser handles both `--name my-app` and `--name=my-app`.
 */

import { describe, it, expect } from 'vitest';
import { normalizeArgs } from '../../src/cli/utils/normalizeArgs.js';

describe('normalizeArgs', () => {
  // ============================================================================
  // Basic splitting
  // ============================================================================

  describe('--key=value splitting', () => {
    it('splits --name=my-app into [--name, my-app]', () => {
      expect(normalizeArgs(['--name=my-app'])).toEqual(['--name', 'my-app']);
    });

    it('splits --entry=./dist/index.js into [--entry, ./dist/index.js]', () => {
      expect(normalizeArgs(['--entry=./dist/index.js'])).toEqual(['--entry', './dist/index.js']);
    });

    it('handles values with multiple equals signs', () => {
      // --env=KEY=VALUE should split on the first = only
      expect(normalizeArgs(['--env=KEY=VALUE'])).toEqual(['--env', 'KEY=VALUE']);
    });

    it('handles empty value after equals', () => {
      expect(normalizeArgs(['--name='])).toEqual(['--name', '']);
    });
  });

  // ============================================================================
  // Passthrough (no splitting needed)
  // ============================================================================

  describe('passthrough (no modification)', () => {
    it('passes --name my-app as-is (space-separated)', () => {
      expect(normalizeArgs(['--name', 'my-app'])).toEqual(['--name', 'my-app']);
    });

    it('passes boolean flags as-is', () => {
      expect(normalizeArgs(['--force', '--ts', '--skip-install'])).toEqual([
        '--force', '--ts', '--skip-install',
      ]);
    });

    it('passes short flags as-is (no splitting on -n=val)', () => {
      // Short flags (-n) don't use = syntax conventionally
      expect(normalizeArgs(['-n', 'my-app'])).toEqual(['-n', 'my-app']);
    });

    it('passes positional arguments as-is', () => {
      expect(normalizeArgs(['my-project', '--mongokit'])).toEqual(['my-project', '--mongokit']);
    });

    it('returns empty array for empty input', () => {
      expect(normalizeArgs([])).toEqual([]);
    });
  });

  // ============================================================================
  // Mixed arguments
  // ============================================================================

  describe('mixed argument styles', () => {
    it('handles a full init command with mixed styles', () => {
      const input = ['my-api', '--name=custom-name', '--mongokit', '--ts', '--force'];
      expect(normalizeArgs(input)).toEqual([
        'my-api', '--name', 'custom-name', '--mongokit', '--ts', '--force',
      ]);
    });

    it('handles multiple --key=value pairs', () => {
      const input = ['--name=app', '--entry=./src/index.ts', '--output=./dist'];
      expect(normalizeArgs(input)).toEqual([
        '--name', 'app', '--entry', './src/index.ts', '--output', './dist',
      ]);
    });

    it('preserves ordering of all arguments', () => {
      const input = ['init', '--name=test', '--force', '--ts'];
      const result = normalizeArgs(input);
      expect(result).toEqual(['init', '--name', 'test', '--force', '--ts']);
      expect(result.indexOf('--name')).toBeLessThan(result.indexOf('test'));
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================

  describe('edge cases', () => {
    it('does not split single-dash flags with equals (-n=val is passed through)', () => {
      // Single dash args are not split — only -- prefix triggers splitting
      expect(normalizeArgs(['-n=val'])).toEqual(['-n=val']);
    });

    it('handles values with spaces (if already quoted by shell)', () => {
      // When the shell passes --name="my project", it arrives as --name=my project
      expect(normalizeArgs(['--name=my project'])).toEqual(['--name', 'my project']);
    });

    it('handles path values with backslashes (Windows)', () => {
      expect(normalizeArgs(['--entry=D:\\projects\\app\\index.ts'])).toEqual([
        '--entry', 'D:\\projects\\app\\index.ts',
      ]);
    });
  });
});
