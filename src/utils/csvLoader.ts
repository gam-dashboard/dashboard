import Papa from 'papaparse';

/**
 * Load a CSV file from the public/data directory
 * @param filePath - The filename (e.g., 'analytics.csv')
 * @returns Promise resolving to an array of parsed CSV objects
 */
export async function loadCSVFromRepo(filePath: string): Promise<any[]> {
  try {
    const response = await fetch(`/dashboard/data/${filePath}`);
    if (!response.ok) {
      throw new Error(`Failed to load CSV: ${response.statusText}`);
    }
    const csv = await response.text();

    return new Promise((resolve, reject) => {
      Papa.parse(csv, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.errors.length > 0) {
            reject(new Error(`CSV parsing error: ${results.errors[0].message}`));
          } else {
            resolve(results.data);
          }
        },
        error: (error) => reject(error),
      });
    });
  } catch (error) {
    console.error('Error loading CSV:', error);
    return [];
  }
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
