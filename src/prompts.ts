import type { ProjectInfo } from './detect.ts';
import type { Role } from './config.ts';
import type { TaskProof } from './redgreen.ts';

// Esquemas estrictos (todas las propiedades requeridas, sin extras): los aceptan Claude y Codex.
const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

export const PLAN_SCHEMA = obj({
  summary: str,
  testCommand: { type: 'string', description: 'Comando para correr TODOS los tests; vacío si hay que crearlo' },
  tasks: {
    type: 'array',
    items: obj({
      id: str,
      title: str,
      kind: { type: 'string', description: 'frontend | backend | game-logic | game-render | infra | tests | docs | other' },
      description: str,
      acceptance: strArr,
      files: strArr,
    }),
  },
  risks: strArr,
});

export const TEST_SCHEMA = obj({
  passed: { type: 'boolean' },
  summary: str,
  testCommand: str,
  criteria: {
    type: 'array',
    items: obj({ criterion: str, status: { type: 'string', enum: ['pass', 'fail', 'uncoverable'] }, evidence: str }),
  },
});

export const REVIEW_SCHEMA = obj({
  verdict: { type: 'string', enum: ['approve', 'changes'] },
  summary: str,
  issues: {
    type: 'array',
    items: obj({ severity: { type: 'string', enum: ['high', 'medium', 'low'] }, file: str, description: str }),
  },
});

export interface PlanTask {
  id: string;
  title: string;
  kind: string;
  description: string;
  acceptance: string[];
  files: string[];
  /** Cuenta elegida por el usuario para esta tarea (sobrescribe rol y routing). */
  account?: string;
}
export interface Plan {
  summary: string;
  testCommand: string;
  tasks: PlanTask[];
  risks: string[];
}
export interface TestReport {
  passed: boolean;
  summary: string;
  testCommand: string;
  criteria: { criterion: string; status: 'pass' | 'fail' | 'uncoverable'; evidence: string }[];
}
export interface Review {
  verdict: 'approve' | 'changes';
  summary: string;
  issues: { severity: 'high' | 'medium' | 'low'; file: string; description: string }[];
}

const COMMON = `Trabajas dentro de un orquestador autónomo de agentes (orcatech). Otros agentes (posiblemente de otros proveedores) hacen las demás fases.
Reglas: nunca hagas git push, deploy ni publiques nada. No toques secretos (.env). Responde en español.`;

export const INSTRUCTIONS: Record<Role, string> = {
  planner: `${COMMON}
Rol: PLANIFICADOR. Solo lees el repositorio; no modificas archivos.
Estudia el código existente, sus patrones y su forma de testear. Convierte la idea en un plan de tareas pequeñas, ordenadas y verificables
(normalmente 2–8). Cada tarea debe poder implementarse y testearse por separado, con criterios de aceptación concretos y observables.
Indica el comando que corre todos los tests (o vacío si el proyecto no tiene y una tarea lo creará).`,
  coder: `${COMMON}
Rol: PROGRAMADOR. Implementas UNA tarea del plan, siguiendo los patrones del código existente.
Escribe los tests junto con el código (no después). Corre los tests relacionados antes de terminar.
No hagas commits: el orquestador los hace. Al final resume qué cambiaste y cómo se verifica.`,
  tester: `${COMMON}
Rol: TESTER DE ACEPTACIÓN. Verificas la funcionalidad completa contra los criterios de aceptación, de afuera hacia adentro
(como la usaría un usuario real). Puedes escribir o ampliar tests de aceptación (Pest feature tests, Playwright, pytest...) y correrlos.
NO modifiques el código de la aplicación: solo tests. Reporta cada criterio como pass, fail o uncoverable con evidencia.`,
  fixer: `${COMMON}
Rol: REPARADOR. Recibes fallos de tests o hallazgos de revisión. Encuentra la causa raíz y corrígela con el cambio mínimo correcto.
No borres ni debilites tests para que pasen. Corre los tests antes de terminar.`,
  reviewer: `${COMMON}
Rol: REVISOR. Solo lees; no modificas archivos. Revisa el diff contra el plan: bugs, casos borde, seguridad (inyección, autorización,
multi-tenancy), tests faltantes y desvíos del alcance. Marca "changes" solo si hay problemas reales; usa severidad high para bugs o fallos de seguridad.`,
};

export function projectContext(info: ProjectInfo): string {
  return `Tipo de proyecto detectado: ${info.type}.\n${info.notes.map((n) => `- ${n}`).join('\n')}`;
}

export function planPrompt(idea: string, info: ProjectInfo): string {
  return `Idea / requerimiento del usuario:\n\n${idea}\n\n${projectContext(info)}\n\nDevuelve el plan en el formato JSON pedido.`;
}

export function taskPrompt(plan: Plan, task: PlanTask, info: ProjectInfo): string {
  const others = plan.tasks.map((t) => `${t.id === task.id ? '→' : ' '} [${t.id}] ${t.title}`).join('\n');
  return `Objetivo general: ${plan.summary}

Plan completo:
${others}

Tu tarea: [${task.id}] ${task.title} (tipo: ${task.kind})
${task.description}

Criterios de aceptación:
${task.acceptance.map((a) => `- ${a}`).join('\n')}

Archivos probables: ${task.files.join(', ') || '(a decidir)'}
Comando de tests: ${plan.testCommand || '(no hay aún; créalo si esta tarea lo requiere)'}

${projectContext(info)}`;
}

export function fixPrompt(context: string, failure: string): string {
  return `${context}\n\nLos tests fallan. Salida (recortada):\n\n\`\`\`\n${failure}\n\`\`\`\n\nCorrige la causa raíz y vuelve a correr los tests.`;
}

/** Pide al reparador reforzar los tests de una tarea cuya prueba red→green salió not-red. */
export function strengthenTestsPrompt(context: string, proof: Pick<TaskProof, 'detail' | 'testFiles'>): string {
  const files = proof.testFiles.length ? proof.testFiles.map((f) => `- ${f}`).join('\n') : '- (no se detectaron archivos de test)';
  return `${context}

La tarea ya está implementada y sus tests pasan, pero la prueba red→green indica que esos tests NO demuestran el cambio:
${proof.detail}

Archivos de test de la tarea:
${files}

Refuerza esos tests o agrega tests nuevos que FALLEN sin la implementación de esta tarea (sobre el código previo a la tarea) y PASEN con ella.
Comprueba el comportamiento observable que introduce la tarea con aserciones concretas.
No debilites, saltes ni borres los tests existentes, y no cambies el código de la aplicación salvo que sea imprescindible.
Corre los tests antes de terminar.`;
}

export function testerPrompt(plan: Plan, info: ProjectInfo): string {
  const criteria = plan.tasks.flatMap((t) => t.acceptance.map((a) => `- [${t.id}] ${a}`)).join('\n');
  return `Objetivo: ${plan.summary}\n\nCriterios de aceptación a verificar:\n${criteria}\n\nComando de tests: ${plan.testCommand || '(detéctalo)'}\n\n${projectContext(info)}\n\nDevuelve el reporte en el formato JSON pedido.`;
}

/** Revisión acotada a una sola tarea: su propio diff contra sus criterios de aceptación. */
export function taskReviewPrompt(plan: Plan, task: PlanTask, diff: string): string {
  return `Objetivo general: ${plan.summary}

Revisa SOLO esta tarea: [${task.id}] ${task.title} (tipo: ${task.kind})
${task.description}

Criterios de aceptación:
${task.acceptance.map((a) => `- ${a}`).join('\n') || '- (sin criterios explícitos)'}

Diff de la tarea (recortado):

\`\`\`diff
${diff}
\`\`\`

Verifica que el diff cumpla los criterios de aceptación de esta tarea y busca bugs, casos borde, problemas de seguridad y tests faltantes
introducidos por este diff. No reportes trabajo que corresponde a otras tareas del plan.
Usa severidad high solo para bugs reales, fallos de seguridad o criterios de aceptación incumplidos.
Puedes leer los archivos completos del repo si necesitas contexto. Devuelve la revisión en el formato JSON pedido.`;
}

export function reviewPrompt(plan: Plan, diff: string): string {
  return `Objetivo: ${plan.summary}\n\nTareas:\n${plan.tasks.map((t) => `- [${t.id}] ${t.title}`).join('\n')}\n\nDiff a revisar (recortado):\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nPuedes leer los archivos completos del repo si necesitas contexto. Devuelve la revisión en el formato JSON pedido.`;
}
