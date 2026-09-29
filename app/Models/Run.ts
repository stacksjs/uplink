import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One text turned into one agent run: what was asked, where it ran, what came
 * back and what it cost. The dashboard's history is this table.
 */
export default defineModel({
  name: 'Run',
  table: 'runs',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Conversation'],

  attributes: {
    chatGuid: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => `iMessage;-;${faker.phone.number()}`,
    },

    messageGuid: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => faker.string.uuid(),
    },

    prompt: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required() },
      factory: faker => faker.lorem.sentence(),
    },

    cwd: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(1024) },
      factory: () => '~',
    },

    status: {
      order: 5,
      fillable: true,
      default: 'queued',
      validation: { rule: schema.enum(['queued', 'running', 'done', 'failed', 'stopped']) },
      factory: faker => faker.helpers.arrayElement(['done', 'failed']),
    },

    reply: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.lorem.paragraph(),
    },

    error: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => '',
    },

    sessionId: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(64) },
      factory: faker => faker.string.uuid(),
    },

    /** Integer cents, never float dollars. */
    costCents: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 200 }),
    },

    durationMs: {
      order: 10,
      fillable: true,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 1000, max: 600000 }),
    },

    lastActivity: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => 'Bash: bun test',
    },

    startedAt: {
      order: 12,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => Date.now(),
    },

    finishedAt: {
      order: 13,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => Date.now(),
    },

    /**
     * Which agent answered. Nullable rather than defaulted: rows written
     * before a thread could choose predate the question, and calling them all
     * Claude would be a guess recorded as a fact.
     */
    engine: {
      order: 14,
      fillable: true,
      validation: { rule: schema.enum(['claude', 'codex']) },
      factory: faker => faker.helpers.arrayElement(['claude', 'codex']),
    },
  },
} as const)
