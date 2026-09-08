import Papa from 'papaparse';

/**
 * Load a CSV file from the src/data directory
 * @param filePath - The filename (e.g., 'SDG_projects.csv')
 * @returns Promise resolving to an array of parsed CSV objects
 */

export async function loadCSVFromRepo(filePathOrUrl: string): Promise<any[]> {
  // Accept either:
  //  - a resolved URL (https://... or starting with /)
  //  - a simple filename (e.g. 'SDG_projects.csv') — in which case construct a URL under the built public path.
  const isAbsolute = /^(?:https?:\/\/|data:|blob:|file:|\/\/)/i.test(filePathOrUrl) || filePathOrUrl.startsWith('/');
  const url = isAbsolute ? filePathOrUrl : `${import.meta.env.BASE_URL ?? '/'}data/${filePathOrUrl}`;
  
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = new Error(`Failed to load CSV: ${resp.status} ${resp.statusText} — ${url}`);
    console.error(err);
    throw err;
    }
  const csv = await resp.text();
  
  return new Promise((resolve, reject) => {
    Papa.parse(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if ((results.errors || []).length > 0) {
          const e = new Error(`CSV parsing error: ${results.errors[0]?.message || 'unknown'}`);
          console.error(e, results.errors);
          reject(e);
        } else {
          resolve(results.data);
        }
      },
      error: (error) => {
        console.error('Papa.parse error', error);
        reject(error);
      },
    });
  });
}

/**
 * Format CSV data for inclusion in LLM prompt context
 * @param data - The parsed CSV data
 * @param maxRows - Maximum number of rows to include in summary (default: 5)
 * @returns String representation suitable for LLM context
 */
export function formatCSVForPrompt(data: any[], maxRows: number = 5): string {
  if (!data || data.length === 0) return 'No data available.';

  const columns = Object.keys(data[0]);
  const sampleData = data.slice(0, maxRows);

  return `
CSV Dataset Summary:
- Total rows: ${data.length}
- Columns: ${columns.join(', ')}

Sample data (first ${Math.min(maxRows, data.length)} rows):
${JSON.stringify(sampleData, null, 2)}

Full dataset contains ${data.length} rows and is available for analysis.
`;
}

/**
 * Get a brief summary of the CSV (useful for context in chat)
 * @param data - The parsed CSV data
 * @returns Summary string with basic statistics
 */
export function getCSVSummary(data: any[]): string {
  if (!data || data.length === 0) return 'No data';

  const columns = Object.keys(data[0]);
  return `Dataset with ${data.length} rows and ${columns.length} columns: ${columns.join(', ')}`;
}
