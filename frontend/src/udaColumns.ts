import type { Measure, UdaColumn, UdaFormat } from './types';

/** Most columns of the UDA export (as the server). */
export const MAX_UDA_COLUMNS = 50;

/**
 * The columns of the UDA export when a discipline has none: the import format of the UDA, without header (as
 * defaultColumns in udaTemplate.ts on the server).
 */
export function defaultColumns(measure: Measure): UdaColumn[] {
  const results = measure === 'distance' ? ['{distance}'] : ['{minutes}', '{seconds}', '{fraction}'];
  return ['{bib}', '{if status == "DQ"}DQ{elif status != "OK"}DNF{end}', ...results].map((value) => ({ title: '', value }));
}

/** Whether columns are those of the UDA format for a measure. */
export function isDefault(columns: UdaColumn[], measure: Measure): boolean {
  const defaults = defaultColumns(measure);
  return columns.length === defaults.length && columns.every((column, index) => column.title === defaults[index].title && column.value === defaults[index].value);
}

/** The UDA export settings edited on the settings page. */
export interface UdaExport {
  header: boolean;
  columns: UdaColumn[];
  separator: string;
  sort: string;
}

/** The UDA format: no header, its columns for the measure, comma separated, by bib. */
export const defaultExport = (measure: Measure): UdaExport => ({ header: false, columns: defaultColumns(measure), separator: ',', sort: 'bib' });

/** The export settings of a format, for a discipline of a measure (columns not set: those of the UDA format). */
export const exportOf = (format: UdaFormat, measure: Measure): UdaExport => ({
  header: format.udaHeader,
  columns: format.udaColumns ?? defaultColumns(measure),
  separator: format.udaSeparator,
  sort: format.udaSort,
});

/** Whether a format is not the UDA format. */
export const isCustom = (format: UdaFormat) => format.udaHeader || format.udaColumns !== null || format.udaSeparator !== ',' || format.udaSort !== 'bib';

/** The UDA export formats of every discipline, the last saved first. */
export async function loadUdaFormats(): Promise<UdaFormat[]> {
  const response = await fetch('/api/uda-formats');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).formats;
}
