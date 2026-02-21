export function formatPathForDisplay(fullPath: string | null): string {
  if (!fullPath) {
    return "Loading...";
  }

  const homeMatch = fullPath.match(/^\/Users\/[^/]+(?:\/|$)/);
  if (homeMatch) {
    const home = homeMatch[0].endsWith("/") ? homeMatch[0].slice(0, -1) : homeMatch[0];
    if (fullPath === home) {
      return "~/";
    }
    if (fullPath.startsWith(`${home}/`)) {
      return `~/${fullPath.slice(home.length + 1)}`;
    }
  }

  return fullPath;
}
