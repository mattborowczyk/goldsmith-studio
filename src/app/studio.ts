/**
 * Backward-compatibility facade for the Feature-Sliced Design (FSD) architecture.
 * All domain models, calculations, and UI components have been migrated to src/features/*
 * and the engine singleton lifecycle and test seams live in src/app/engine.ts.
 */
export * from '@/app/engine'
export * from '@/core/controller/context'
export * from '@/features/cost-materials'
export * from '@/features/deliver'
export * from '@/features/generators'
export * from '@/features/grillz'
export * from '@/features/import'
export * from '@/features/measure-section'
export * from '@/features/pwa'
export * from '@/features/repair'
export * from '@/features/resize'
export * from '@/features/storage'
export * from '@/features/theme'
