import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProjectType = 'laravel' | 'browser-game' | 'node' | 'python' | 'unknown';

export interface ProjectInfo {
  type: ProjectType;
  testCommand?: string;
  /** Pistas para los agentes según el stack. */
  notes: string[];
}

function readPkg(repo: string): any | undefined {
  const p = join(repo, 'package.json');
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

export function detectProject(repo: string): ProjectInfo {
  const has = (f: string) => existsSync(join(repo, f));
  const pkg = readPkg(repo);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies } as Record<string, string>;
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const testScript = scripts.test && !/no test specified/.test(scripts.test) ? 'npm test' : undefined;
  const npmTest = [scripts.typecheck ? 'npm run typecheck' : undefined, testScript].filter(Boolean).join(' && ') || undefined;
  const readHead = (f: string) => (has(f) ? readFileSync(join(repo, f), 'utf8').slice(0, 3000) : '');

  if (has('artisan') && has('composer.json')) {
    const pest = has('vendor/bin/pest');
    return {
      type: 'laravel',
      testCommand: pest ? 'vendor/bin/pest' : 'php artisan test',
      notes: [
        'Proyecto Laravel: usa Pest para tests de backend (tests/Feature, tests/Unit), FormRequests, migraciones y factories.',
        deps['@inertiajs/vue3'] ? 'Frontend Inertia + Vue 3.' : deps['@inertiajs/react'] ? 'Frontend Inertia + React.' : '',
        'No ejecutes migraciones contra bases de datos reales; los tests usan RefreshDatabase.',
      ].filter(Boolean),
    };
  }

  const gameDeps = ['phaser', 'pixi.js', 'three', 'kaboom', 'excalibur', 'babylonjs', '@babylonjs/core'];
  const blurb = `${pkg?.name ?? ''} ${pkg?.description ?? ''} ${readHead('README.md')}`;
  const isGame =
    gameDeps.some((d) => deps?.[d]) ||
    /\b(game|juego|moba|battle royale|shooter|platformer|roguelike|multiplayer|multijugador)\b/i.test(blurb) ||
    /<canvas/i.test(readHead('index.html'));
  if (pkg && isGame) {
    const pw = deps['@playwright/test'] ? 'npx playwright test' : undefined;
    return {
      type: 'browser-game',
      testCommand: [npmTest, pw].filter(Boolean).join(' && ') || undefined,
      notes: [
        'Juego de navegador: separa la lógica del juego (determinista, testeable) del render/canvas.',
        'Prueba la lógica con tests unitarios y la jugabilidad con Playwright (carga, sin errores de consola, inputs básicos).',
        'Juego original: no copies nombres, arte ni niveles de juegos existentes.',
      ],
    };
  }

  if (pkg) {
    return { type: 'node', testCommand: npmTest, notes: ['Proyecto Node/TypeScript: sigue el estilo de módulos y el runner de tests existente.'] };
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    return { type: 'python', testCommand: 'python -m pytest -q', notes: ['Proyecto Python: tests con pytest.'] };
  }
  return { type: 'unknown', notes: ['Proyecto nuevo o sin stack detectado: elige un stack simple y deja un comando de tests funcionando.'] };
}
