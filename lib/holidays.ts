/**
 * National public holidays, so AI calls don't go out on days people are off (and when
 * calling is frowned on or restricted, e.g. Sundays and public holidays in Australia).
 * Country-wide holidays only — regional ones (German states, US state holidays) aren't
 * included. Moving dates are calculated (Easter, "last Monday of May"…); the few that follow
 * lunar calendars come from a table.
 *
 * Pure date maths, safe in the browser too (lib/countryTiming.ts uses it).
 */

type Day = [month: number, day: number, name: string];

/** Easter Sunday (Gregorian), Anonymous Gregorian algorithm. */
function easter(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

function shift(year: number, [month, day]: [number, number], days: number): [number, number] {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return [d.getUTCMonth() + 1, d.getUTCDate()];
}

/** nth (1-based) weekday (0 = Sunday) of a month; n = -1 for the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): [number, number] {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return [month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7];
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return [month, lastDay - ((last - weekday + 7) % 7)];
}

/** A fixed-date holiday that falls on a weekend is usually given on the nearest weekday
 * (US: Sat→Fri, Sun→Mon; UK: next weekday). Both the date and its observed day are off. */
function observed(year: number, month: number, day: number, style: 'us' | 'uk'): [number, number] | null {
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (style === 'us') return wd === 6 ? shift(year, [month, day], -1) : wd === 0 ? shift(year, [month, day], 1) : null;
  return wd === 6 ? shift(year, [month, day], 2) : wd === 0 ? shift(year, [month, day], 1) : null;
}

// Diwali (Lakshmi Puja), national in practice across India.
const DIWALI: Record<number, [number, number]> = { 2025: [10, 20], 2026: [11, 8], 2027: [10, 29], 2028: [10, 17], 2029: [11, 5], 2030: [10, 26] };

function holidaysFor(country: string, year: number): Day[] {
  const E = easter(year);
  const at = (md: [number, number], name: string): Day => [md[0], md[1], name];
  const goodFriday = at(shift(year, E, -2), 'Good Friday');
  const easterMonday = at(shift(year, E, 1), 'Easter Monday');
  const ascension = at(shift(year, E, 39), 'Ascension Day');
  const whitMonday = at(shift(year, E, 50), 'Whit Monday');
  const withObserved = (list: Day[], style: 'us' | 'uk'): Day[] => [
    ...list,
    ...list.flatMap(([m, d, name]) => {
      const o = observed(year, m, d, style);
      return o ? [at(o, `${name} (observed)`)] : [];
    }),
  ];

  switch (country) {
    case 'unitedstates':
      return [
        ...withObserved([[1, 1, "New Year's Day"], [6, 19, 'Juneteenth'], [7, 4, 'Independence Day'], [12, 25, 'Christmas Day']], 'us'),
        at(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day'),
        at(nthWeekday(year, 2, 1, 3), "Presidents' Day"),
        at(nthWeekday(year, 5, 1, -1), 'Memorial Day'),
        at(nthWeekday(year, 9, 1, 1), 'Labor Day'),
        at(nthWeekday(year, 11, 4, 4), 'Thanksgiving'),
      ];
    case 'canada': {
      const may25 = new Date(Date.UTC(year, 4, 25)).getUTCDay();
      return [
        ...withObserved([[1, 1, "New Year's Day"], [7, 1, 'Canada Day'], [12, 25, 'Christmas Day'], [12, 26, 'Boxing Day']], 'uk'),
        goodFriday,
        at([5, 25 - ((may25 + 6) % 7 || 7)], 'Victoria Day'),
        at(nthWeekday(year, 9, 1, 1), 'Labour Day'),
        at(nthWeekday(year, 10, 1, 2), 'Thanksgiving'),
      ];
    }
    case 'unitedkingdom':
      return [
        ...withObserved([[1, 1, "New Year's Day"], [12, 25, 'Christmas Day'], [12, 26, 'Boxing Day']], 'uk'),
        goodFriday,
        easterMonday,
        at(nthWeekday(year, 5, 1, 1), 'Early May bank holiday'),
        at(nthWeekday(year, 5, 1, -1), 'Spring bank holiday'),
        at(nthWeekday(year, 8, 1, -1), 'Summer bank holiday'),
      ];
    case 'ireland':
      return [
        [1, 1, "New Year's Day"],
        at(new Date(Date.UTC(year, 1, 1)).getUTCDay() === 5 ? [2, 1] : nthWeekday(year, 2, 1, 1), "St Brigid's Day"),
        [3, 17, "St Patrick's Day"],
        easterMonday,
        at(nthWeekday(year, 5, 1, 1), 'May bank holiday'),
        at(nthWeekday(year, 6, 1, 1), 'June bank holiday'),
        at(nthWeekday(year, 8, 1, 1), 'August bank holiday'),
        at(nthWeekday(year, 10, 1, -1), 'October bank holiday'),
        [12, 25, 'Christmas Day'],
        [12, 26, "St Stephen's Day"],
      ];
    case 'india':
      return [[1, 26, 'Republic Day'], [8, 15, 'Independence Day'], [10, 2, 'Gandhi Jayanti'], ...(DIWALI[year] ? [at(DIWALI[year], 'Diwali')] : [])];
    case 'germany':
      return [[1, 1, 'Neujahr'], goodFriday, easterMonday, [5, 1, 'Tag der Arbeit'], ascension, whitMonday, [10, 3, 'Tag der Deutschen Einheit'], [12, 25, 'Weihnachten'], [12, 26, 'Zweiter Weihnachtstag']];
    case 'austria':
      return [[1, 1, 'Neujahr'], [1, 6, 'Heilige Drei Könige'], easterMonday, [5, 1, 'Staatsfeiertag'], ascension, whitMonday, at(shift(year, E, 60), 'Fronleichnam'), [8, 15, 'Mariä Himmelfahrt'], [10, 26, 'Nationalfeiertag'], [11, 1, 'Allerheiligen'], [12, 8, 'Mariä Empfängnis'], [12, 25, 'Christtag'], [12, 26, 'Stefanitag']];
    case 'switzerland':
      return [[1, 1, 'Neujahr'], goodFriday, easterMonday, ascension, whitMonday, [8, 1, 'Bundesfeier'], [12, 25, 'Weihnachten'], [12, 26, 'Stephanstag']];
    case 'france':
      return [[1, 1, "Jour de l'an"], easterMonday, [5, 1, 'Fête du Travail'], [5, 8, 'Victoire 1945'], ascension, whitMonday, [7, 14, 'Fête nationale'], [8, 15, 'Assomption'], [11, 1, 'Toussaint'], [11, 11, 'Armistice'], [12, 25, 'Noël']];
    case 'belgium':
      return [[1, 1, 'New Year'], easterMonday, [5, 1, 'Labour Day'], ascension, whitMonday, [7, 21, 'National Day'], [8, 15, 'Assumption'], [11, 1, "All Saints' Day"], [11, 11, 'Armistice Day'], [12, 25, 'Christmas']];
    case 'luxembourg':
      return [[1, 1, 'New Year'], easterMonday, [5, 1, 'Labour Day'], [5, 9, 'Europe Day'], ascension, whitMonday, [6, 23, 'National Day'], [8, 15, 'Assumption'], [11, 1, "All Saints' Day"], [12, 25, 'Christmas'], [12, 26, "St Stephen's Day"]];
    case 'spain':
      return [[1, 1, 'Año Nuevo'], [1, 6, 'Epifanía'], goodFriday, [5, 1, 'Día del Trabajador'], [8, 15, 'Asunción'], [10, 12, 'Fiesta Nacional'], [11, 1, 'Todos los Santos'], [12, 6, 'Día de la Constitución'], [12, 8, 'Inmaculada Concepción'], [12, 25, 'Navidad']];
    case 'portugal':
      return [[1, 1, 'Ano Novo'], goodFriday, [4, 25, 'Dia da Liberdade'], [5, 1, 'Dia do Trabalhador'], at(shift(year, E, 60), 'Corpo de Deus'), [6, 10, 'Dia de Portugal'], [8, 15, 'Assunção'], [10, 5, 'Implantação da República'], [11, 1, 'Todos os Santos'], [12, 1, 'Restauração da Independência'], [12, 8, 'Imaculada Conceição'], [12, 25, 'Natal']];
    case 'italy':
      return [[1, 1, 'Capodanno'], [1, 6, 'Epifania'], easterMonday, [4, 25, 'Festa della Liberazione'], [5, 1, 'Festa del Lavoro'], [6, 2, 'Festa della Repubblica'], [8, 15, 'Ferragosto'], [11, 1, 'Ognissanti'], [12, 8, 'Immacolata'], [12, 25, 'Natale'], [12, 26, 'Santo Stefano']];
    case 'netherlands': {
      const kingsDay: [number, number] = new Date(Date.UTC(year, 3, 27)).getUTCDay() === 0 ? [4, 26] : [4, 27];
      return [[1, 1, 'Nieuwjaarsdag'], goodFriday, easterMonday, at(kingsDay, 'Koningsdag'), ascension, whitMonday, [12, 25, 'Kerstmis'], [12, 26, 'Tweede Kerstdag']];
    }
    case 'denmark':
      return [[1, 1, 'Nytår'], at(shift(year, E, -3), 'Skærtorsdag'), goodFriday, easterMonday, ascension, whitMonday, [6, 5, 'Grundlovsdag'], [12, 24, 'Juleaften'], [12, 25, 'Juledag'], [12, 26, 'Anden juledag']];
    case 'sweden':
      return [[1, 1, 'Nyårsdagen'], [1, 6, 'Trettondedag jul'], goodFriday, easterMonday, [5, 1, 'Första maj'], ascension, [6, 6, 'Nationaldagen'], [12, 24, 'Julafton'], [12, 25, 'Juldagen'], [12, 26, 'Annandag jul'], [12, 31, 'Nyårsafton']];
    case 'norway':
      return [[1, 1, 'Nyttårsdag'], at(shift(year, E, -3), 'Skjærtorsdag'), goodFriday, easterMonday, [5, 1, 'Arbeidernes dag'], [5, 17, 'Grunnlovsdag'], ascension, whitMonday, [12, 25, 'Juledag'], [12, 26, 'Andre juledag']];
    case 'finland':
      return [[1, 1, 'Uudenvuodenpäivä'], [1, 6, 'Loppiainen'], goodFriday, easterMonday, [5, 1, 'Vappu'], ascension, [12, 6, 'Itsenäisyyspäivä'], [12, 24, 'Jouluaatto'], [12, 25, 'Joulupäivä'], [12, 26, 'Tapaninpäivä']];
    case 'poland':
      return [[1, 1, 'Nowy Rok'], [1, 6, 'Trzech Króli'], easterMonday, [5, 1, 'Święto Pracy'], [5, 3, 'Święto Konstytucji'], at(shift(year, E, 60), 'Boże Ciało'), [8, 15, 'Wniebowzięcie'], [11, 1, 'Wszystkich Świętych'], [11, 11, 'Święto Niepodległości'], [12, 24, 'Wigilia'], [12, 25, 'Boże Narodzenie'], [12, 26, 'Drugi dzień świąt']];
    case 'greece':
      return [[1, 1, 'New Year'], [1, 6, 'Epiphany'], [3, 25, 'Independence Day'], [5, 1, 'Labour Day'], [8, 15, 'Assumption'], [10, 28, 'Ohi Day'], [12, 25, 'Christmas'], [12, 26, 'Synaxis of the Theotokos']];
    case 'australia':
      return [
        ...withObserved([[1, 1, "New Year's Day"], [1, 26, 'Australia Day'], [12, 25, 'Christmas Day'], [12, 26, 'Boxing Day']], 'uk'),
        goodFriday,
        at(shift(year, E, 1), 'Easter Monday'),
        [4, 25, 'Anzac Day'],
      ];
    case 'newzealand':
      return [[1, 1, "New Year's Day"], [1, 2, "Day after New Year's"], [2, 6, 'Waitangi Day'], goodFriday, easterMonday, [4, 25, 'Anzac Day'], at(nthWeekday(year, 6, 1, 1), "King's Birthday"), at(nthWeekday(year, 10, 1, 4), 'Labour Day'), [12, 25, 'Christmas Day'], [12, 26, 'Boxing Day']];
    case 'uae':
      return [[1, 1, "New Year's Day"], [12, 2, 'National Day'], [12, 3, 'National Day']];
    case 'singapore':
      return [[1, 1, "New Year's Day"], goodFriday, [5, 1, 'Labour Day'], [8, 9, 'National Day'], [12, 25, 'Christmas Day']];
    default:
      return [];
  }
}

/** The holiday's name if this local date is a national public holiday in the country (a
 * key from lib/countryTiming.ts), else null. */
export function publicHoliday(countryKey: string, year: number, month: number, day: number): string | null {
  const hit = holidaysFor(countryKey, year).find(([m, d]) => m === month && d === day);
  return hit ? hit[2] : null;
}
