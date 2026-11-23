export const recordSchema = (properties: object, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
