import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A Messages thread Uplink takes commands from, and the Claude Code session
 * that thread is continuing. One row per chat.
 */
export default defineModel({
  name: 'Conversation',
  table: 'conversations',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  hasMany: ['Run'],

  attributes: {
    chatGuid: {
      order: 1,
      fillable: true,
      unique: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => `iMessage;-;${faker.phone.number()}`,
    },

    handle: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => faker.phone.number(),
    },

    service: {
      order: 3,
      fillable: true,
      default: 'iMessage',
      validation: { rule: schema.string().max(20) },
      factory: () => 'iMessage',
    },

    sessionId: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(64) },
      factory: faker => faker.string.uuid(),
    },

    cwd: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(1024) },
      factory: () => '~',
    },

    /** Unix milliseconds of the last finished run. */
    lastActiveAt: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => Date.now(),
    },

    /** The unsent tail of the last long reply. */
    moreText: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => '',
    },

    /**
     * The engine this thread was switched to, or null to follow whatever the
     * installation is set to. Null is the point: a thread that never asked
     * keeps tracking the menubar's picker, so changing it there still works.
     */
    engine: {
      order: 8,
      fillable: true,
      validation: { rule: schema.enum(['claude', 'codex']) },
      factory: () => 'claude',
    },
  },
} as const)
