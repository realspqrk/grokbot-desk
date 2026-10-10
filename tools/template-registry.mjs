import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function pythonCommand() {
  if (process.env.RS_PYTHON) return [process.env.RS_PYTHON, []];
  return process.platform === 'win32' ? ['py', ['-3']] : ['python3', []];
}

export function resolvedTemplates(root, selected = null) {
  const [python, prefix] = pythonCommand();
  const result = spawnSync(
    python,
    [
      ...prefix,
      path.join(root, 'report_shell.py'),
      'templates',
      '--json',
      '--paths',
    ],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    },
  );
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`template registry lookup failed: ${detail}`);
  }
  const entries = JSON.parse(result.stdout);
  const templates = entries
    .filter((entry) => !selected || selected === '--all' || entry.id === selected)
    .map((entry) => ({
      dir: entry.path,
      manifest: JSON.parse(
        readFileSync(path.join(entry.path, 'template.json'), 'utf8'),
      ),
    }));
  if (selected && selected !== '--all' && templates.length === 0) {
    throw new Error(`unknown template: ${selected}`);
  }
  return templates;
}
