/**
 * Template Seeding Service
 *
 * Seeds default email templates into an organization's account
 * Can be called during onboarding or manually via API
 */

import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import { ALL_DEFAULT_TEMPLATES, type DefaultTemplate } from './default-templates.js';

const log = logger.child({ module: 'template-seed' });

/**
 * Seed default templates for an organization
 * Skips templates that already exist with the same name
 */
export async function seedDefaultTemplates(
  organizationId: string,
  options: {
    overwrite?: boolean; // Overwrite existing templates with same name
    categories?: string[]; // Only seed specific categories
  } = {}
): Promise<{ created: number; skipped: number; updated: number }> {
  const operationLog = log.child({
    operation: 'seedDefaultTemplates',
    organizationId,
  });

  try {
    let created = 0;
    let skipped = 0;
    let updated = 0;

    // Filter templates by category if specified
    const templatesToSeed = options.categories
      ? ALL_DEFAULT_TEMPLATES.filter((t) => options.categories!.includes(t.category))
      : ALL_DEFAULT_TEMPLATES;

    operationLog.info(
      { templatesCount: templatesToSeed.length },
      'Starting template seeding'
    );

    for (const template of templatesToSeed) {
      try {
        // Check if template already exists
        const existing = await prisma.emailTemplate.findFirst({
          where: {
            organizationId,
            name: template.name,
          },
        });

        if (existing && !options.overwrite) {
          operationLog.debug({ templateName: template.name }, 'Template already exists, skipping');
          skipped++;
          continue;
        }

        if (existing && options.overwrite) {
          // Update existing template
          await prisma.emailTemplate.update({
            where: { id: existing.id },
            data: {
              description: template.description,
              category: template.category as any,
              subject: template.subject,
              htmlBody: template.htmlBody,
              textBody: template.textBody,
              availableTags: template.availableTags,
              status: 'ACTIVE',
            },
          });

          operationLog.info({ templateName: template.name }, 'Template updated');
          updated++;
        } else {
          // Create new template
          await prisma.emailTemplate.create({
            data: {
              organizationId,
              name: template.name,
              description: template.description,
              category: template.category as any,
              status: 'ACTIVE',
              subject: template.subject,
              htmlBody: template.htmlBody,
              textBody: template.textBody,
              availableTags: template.availableTags,
              sentCount: 0,
              openRate: 0,
              clickRate: 0,
              conversionRate: 0,
            },
          });

          operationLog.info({ templateName: template.name }, 'Template created');
          created++;
        }
      } catch (error) {
        operationLog.error(
          { templateName: template.name, error },
          'Failed to seed template'
        );
        // Continue with other templates even if one fails
      }
    }

    const summary = { created, skipped, updated };
    operationLog.info(summary, 'Template seeding completed');

    return summary;
  } catch (error) {
    operationLog.error({ error }, 'Failed to seed default templates');
    throw error;
  }
}

/**
 * Seed templates for a specific category
 */
export async function seedCategoryTemplates(
  organizationId: string,
  category: string
): Promise<{ created: number; skipped: number; updated: number }> {
  return seedDefaultTemplates(organizationId, { categories: [category] });
}

/**
 * Get list of available default templates
 */
export function listDefaultTemplates(): Array<{
  name: string;
  description: string;
  category: string;
}> {
  return ALL_DEFAULT_TEMPLATES.map((t) => ({
    name: t.name,
    description: t.description,
    category: t.category,
  }));
}

/**
 * Get available template categories
 */
export function getTemplateCategories(): string[] {
  const categories = new Set(ALL_DEFAULT_TEMPLATES.map((t) => t.category));
  return Array.from(categories);
}

/**
 * Check if an organization has any templates
 */
export async function hasTemplates(organizationId: string): Promise<boolean> {
  const count = await prisma.emailTemplate.count({
    where: { organizationId },
  });
  return count > 0;
}

/**
 * Auto-seed templates for new organizations
 * Called during organization onboarding
 */
export async function autoSeedForNewOrganization(
  organizationId: string
): Promise<void> {
  const operationLog = log.child({
    operation: 'autoSeedForNewOrganization',
    organizationId,
  });

  try {
    // Check if organization already has templates
    const hasExisting = await hasTemplates(organizationId);

    if (hasExisting) {
      operationLog.info('Organization already has templates, skipping auto-seed');
      return;
    }

    // Seed all default templates
    const result = await seedDefaultTemplates(organizationId);

    operationLog.info(result, 'Auto-seeded templates for new organization');
  } catch (error) {
    operationLog.error({ error }, 'Failed to auto-seed templates');
    // Don't throw - template seeding failure shouldn't block organization creation
  }
}
