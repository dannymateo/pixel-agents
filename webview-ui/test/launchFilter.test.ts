import { expect, test } from 'vitest';

import type { MachineProject } from '../../core/src/messages.js';
import { filterProjects, timeAgo } from '../src/console/launchFilter.js';

const project = (name: string, cwd: string): MachineProject => ({ name, cwd, lastUsed: 1 });

test('filterProjects: empty query returns every project, in order', () => {
  const projects = [project('Alpha', '/a'), project('Beta', '/b')];
  expect(filterProjects(projects, '')).toEqual(projects);
});

test('filterProjects: matches case- and accent-insensitively on name', () => {
  const projects = [project('Álvaro', '/x/alvaro'), project('Beta', '/y/beta')];
  expect(filterProjects(projects, 'alvaro')).toEqual([projects[0]]);
});

test('filterProjects: matches on cwd too, preserving the original order', () => {
  const projects = [
    project('Uno', '/home/dev/proyecto-uno'),
    project('Dos', '/home/dev/proyecto-dos'),
    project('Tres', '/other/tres'),
  ];
  expect(filterProjects(projects, 'proyecto')).toEqual([projects[0], projects[1]]);
});

test('filterProjects: no match returns an empty list', () => {
  const projects = [project('Alpha', '/a')];
  expect(filterProjects(projects, 'zzz')).toEqual([]);
});

test('timeAgo: lastUsed 0 is unknown and renders as nothing', () => {
  expect(timeAgo(0, Date.now())).toBe('');
});

test('timeAgo: minutes', () => {
  const now = 1_000_000_000;
  expect(timeAgo(now - 5 * 60_000, now)).toBe('hace 5 min');
});

test('timeAgo: hours', () => {
  const now = 1_000_000_000;
  expect(timeAgo(now - 3 * 60 * 60_000, now)).toBe('hace 3 h');
});

test('timeAgo: days', () => {
  const now = 1_000_000_000;
  expect(timeAgo(now - 2 * 24 * 60 * 60_000, now)).toBe('hace 2 d');
});
