/** Providers use both a currency symbol and ISO code for the same shekel amount. */
export function normalizeCurrency(value: string): string {
    const currency = value.trim().toUpperCase();
    return ['₪', 'ILS', 'NIS', 'שח', 'ש"ח', 'ש״ח'].includes(currency) ? 'ILS' : currency;
}
