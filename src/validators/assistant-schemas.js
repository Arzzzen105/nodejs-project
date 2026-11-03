import { z } from 'zod';

/**
 * Schema for creating an assistant.
 */
export const createAssistantSchema = z.object({
    name: z.string().min(1, { message: 'Name is required' }),
    // Додайте інші поля, які є у вашій базі даних для асистентів, наприклад:
    // email: z.string().email().optional(),
    // phone: z.string().optional(),
});

/**
 * Schema for updating an assistant (all fields optional for PATCH).
 */
export const updateAssistantSchema = createAssistantSchema.partial();
