/** The path of subfolder `name` inside `path` (both relative to the engine's browse root). */
export const enter = (path: string, name: string) => (path ? `${path}/${name}` : name);
