/**
 * Classification: relevance filtering, category, institution and verification.
 *
 * Nigerian education feeds mix hard news with affiliate spam and lifestyle
 * posts, so every article is scored before it is stored.
 */

export interface Classification {
  category: string;
  institution: string | null;
  country: string;
  relevant: boolean;
  relevanceScore: number;
  matchedTerms: string[];
  tags: string[];
}

/** Terms that strongly indicate Nigerian tertiary-education content. */
const TERTIARY_TERMS = [
  'university', 'polytechnic', 'college of education', 'monotechnic', 'institute of technology',
  'faculty', 'vice chancellor', 'vice-chancellor', 'vice chancellor', 'registrar', 'bursar',
  'senate', 'matriculation', 'convocation', 'graduation', 'alumni', 'undergraduate', 'postgraduate',
  'undergrad', 'postgrad', 'lecturer', 'professor', 'academic staff', 'asuu', 'ssanu', 'nasaru',
  'jamb', 'utme', 'post-utme', 'post utme', 'direct entry', 'admission', 'admissions', 'cut-off',
  'cut off mark', 'nuc', 'nbte', 'ncce', 'tetfund', 'neco', 'waec', 'nabteb', 'nce result',
  'degree programme', 'degree program', 'accreditation', 'accredited', 'campus', 'students union',
  'student union', 'hostel', 'school fees', 'acceptance fee', 'tuition', 'siwes', 'nySC', 'nysc',
  'scholarship', 'bursary', 'research grant', 'thesis', 'dissertation', 'department of',
  'hnd', 'ond', 'postgraduate school', 'academic session', 'session resumption', 'resumption',
  'first class', 'cgpa', 'semester', 'exam', 'examination', 'examination malpractice',
  'tertiary institution', 'tertiary education', 'ministry of education', 'education minister',
  'higher education', 'school of nursing', 'college of health', 'study centre',
];

/** General-news education signals (weaker than tertiary terms). */
const EDUCATION_TERMS = [
  'education', 'school', 'teacher', 'pupil', 'student', 'learning', 'curriculum',
  'classroom', 'exam', 'academic', 'literacy', 'classrooms', 'lesson', 'teaching',
];

/** Nigerian country signals. */
const NIGERIA_TERMS = [
  'nigeria', 'nigerian', 'nigerians', 'abuja', 'lagos', 'kano', 'ibadan', 'port harcourt',
  'enugu', 'aba', 'jos', 'ilorin', 'benin city', 'zaria', 'maiduguri', 'sokoto', 'calabar',
  'federal capital territory', 'fct', 'nasarawa', 'ekiti', 'osun', 'oyo', 'imo', 'anambra',
  'delta', 'edo', 'kaduna', 'bauchi', 'gombe', 'adamawa', 'taraba', 'plateau', 'benue',
];

/** Off-topic signals that veto an article outright. */
const BLOCKLIST = [
  'casino', 'togel', 'slot gacor', 'sports betting', 'betting tips', 'odds', 'jackpot',
  'porn', 'escort', 'crypto airdrop', 'forex signal', 'loan app', 'jamb expo', 'expo',
  'runs', 'yahoo boy', 'download mp3', 'nollywood', 'celebrity gossip', 'horoscope',
  'weight loss', 'diet plan', 'fashion trends', 'bet9ja', '1xbet', 'sportybet',
];

/** Category keyword rules, evaluated in priority order. */
const CATEGORY_RULES: Array<{ category: string; terms: string[] }> = [
  {
    category: 'Accreditation',
    terms: ['accreditation', 'accredited', 'nuc approval', 'programme approval', 'approves programme',
      'new programme', 'resource verification', 'curriculum review', 'nbte approval', 'nce approval'],
  },
  {
    category: 'Scholarship',
    terms: ['scholarship', 'bursary', 'grant', 'fellowship', 'sponsorship', 'award for', 'scholarships',
      'study abroad', 'fully funded'],
  },
  {
    // Checked before Admissions: a story about results or a sitting is exam
    // news even when the headline also mentions JAMB or UTME.
    category: 'Examinations',
    terms: ['result', 'results', 'waec', 'neco', 'nabteb', 'examination', 'exam', 'cbt',
      'post utme result', 'released result', 'releases result', 'released results',
      'jamb result', 'jamb results', 'utme result', 'utme results', 'withheld result',
      'withheld results', 'grading', 'malpractice', 'score', 'scores'],
  },
  {
    category: 'Admissions',
    terms: ['admission', 'admissions', 'post-utme', 'post utme', 'utme', 'direct entry', 'cut-off',
      'cut off mark', 'screening exercise', 'supplementary admission', 'admission list', 'jamb',
      'change of course', 'change of institution', 'supplementary list', 'sells form', 'sale of form'],
  },
  {
    category: 'Funding',
    terms: ['tetfund', 'funding', 'intervention', 'budget', 'allocation', 'appropriation', 'research fund',
      'infrastructure', 'capital project', 'nelfund', 'student loan'],
  },
  {
    category: 'Appointments',
    terms: ['appointed', 'appointment', 'vice chancellor', 'vice-chancellor', 'registrar', 'rector', 'provost',
      'new dg', 'director general', 'sacked', 'suspends', 'suspended', 'resigns', 'bows out', 'inaugurated'],
  },
  {
    category: 'Policy',
    terms: ['policy', 'minister', 'ministry', 'federal government', 'national assembly', 'bill', 'act',
      'reform', 'directive', 'ban', 'guideline', 'regulator', 'strike', 'asuu', 'union', 'protest',
      'minimum wage', 'salary', 'allowance'],
  },
  {
    category: 'Research',
    terms: ['research', 'researchers', 'researcher', 'study', 'studies', 'study finds', 'study reveals',
      'scientists', 'publish', 'publishes', 'published', 'journal', 'publication', 'findings',
      'breakthrough', 'innovation', 'patent', 'conference', 'symposium', 'thesis'],
  },
  {
    category: 'Campus',
    terms: ['campus', 'students union', 'student union', 'hostel', 'convocation', 'matriculation',
      'graduation', 'alumni', 'sports', 'fellowship', 'orientation', 'resumption', 'academic session',
      'school fees', 'acceptance fee', 'expelled', 'rusticated', 'cultism'],
  },
];

/** Well-known Nigerian institutions, longest-first for greedy matching. */
const KNOWN_INSTITUTIONS = [
  'Federal University of Technology Owerri', 'FUTO',
  'University of Lagos', 'UNILAG',
  'University of Ibadan', 'UI',
  'Obafemi Awolowo University', 'OAU',
  'Ahmadu Bello University', 'ABU Zaria', 'ABU',
  'University of Nigeria Nsukka', 'UNN',
  'University of Benin', 'UNIBEN',
  'University of Ilorin', 'UNILORIN',
  'University of Calabar', 'UNICAL',
  'University of Port Harcourt', 'UNIPORT',
  'University of Jos', 'UNIJOS',
  'University of Maiduguri', 'UNIMAID',
  'Bayero University Kano', 'BUK',
  'Federal University of Technology Akure', 'FUTA',
  'Federal University of Technology Minna', 'FUTMINNA',
  'Federal University of Technology Ikot Abasi', 'FUTIA',
  'Lagos State University', 'LASU',
  'Ambrose Alli University', 'AAU Ekpoma',
  'Nnamdi Azikiwe University', 'UNIZIK',
  'Michael Okpara University of Agriculture', 'MOUAU',
  'Federal University of Agriculture Abeokuta', 'FUNAAB',
  'Yaba College of Technology', 'YABATECH',
  'Kaduna Polytechnic', 'Federal Polytechnic Nekede', 'Federal Polytechnic Ilaro',
  'Auchi Polytechnic', 'Federal Polytechnic Bida', 'Federal Polytechnic Offa',
  'Alvan Ikoku Federal College of Education', 'Federal College of Education',
  'National Universities Commission', 'National Board for Technical Education',
  'National Commission for Colleges of Education', 'Joint Admissions and Matriculation Board',
  'Tertiary Education Trust Fund', 'Federal Ministry of Education',
  'Nigerian Defence Academy', 'NDA',
  'African University of Science and Technology',
  'Covenant University', 'Babcock University', 'Bowen University', 'Redeemer\'s University',
  'Landmark University', 'Afe Babalola University', 'Bells University of Technology',
  'Nile University of Nigeria', 'Baze University', 'Elizade University',
  'Federal University of Health Sciences Otukpo', 'FUHSO',
  'Federal University of Health Sciences Azare',
];

const INSTITUTION_LOOKUP = [...KNOWN_INSTITUTIONS].sort((a, b) => b.length - a.length);

/** Generic patterns for institutions not in the known list. */
/** Headline verbs and filler that can precede an institution name. */
const LEADING_STOPWORDS = new Set([
  'the', 'a', 'an', 'new', 'this', 'that', 'these', 'those', 'our', 'its', 'his', 'her', 'their',
  'approves', 'approve', 'approved', 'announces', 'announce', 'announced', 'releases', 'release',
  'released', 'holds', 'hold', 'wins', 'win', 'says', 'said', 'commissions', 'commission',
  'inaugurates', 'inaugurate', 'names', 'name', 'named', 'appoints', 'appoint', 'appointed',
  'suspends', 'suspend', 'matriculates', 'graduates', 'admits', 'begins', 'begin', 'ends', 'end',
  'lists', 'list', 'reveals', 'reveal', 'denies', 'deny', 'confirms', 'confirm', 'warns', 'urges',
  'asks', 'calls', 'meets', 'visits', 'signs', 'launches', 'opens', 'shuts', 'extends', 'cancels',
  'postpones', 'sets', 'gets', 'makes', 'takes', 'gives', 'faces', 'records', 'emerges', 'tops',
  'leads', 'sacks', 'dismisses', 'expels', 'rusticates', 'honours', 'celebrates', 'marks', 'joins',
  'partners', 'receives', 'gets', 'over', 'as', 'and', 'for', 'from', 'into', 'at', 'in', 'on',
]);

/** Strip leading headline verbs so "Approves X University" yields "X University". */
function trimLeadingStopwords(name: string): string {
  const tokens = name.split(/\s+/).filter(Boolean);
  while (tokens.length > 1) {
    const head = tokens[0].toLowerCase().replace(/[^\p{L}]/gu, '');
    if (!LEADING_STOPWORDS.has(head)) break;
    tokens.shift();
  }
  return tokens.join(' ');
}

const INSTITUTION_PATTERNS: RegExp[] = [
  // Longest realistic run of capitalised words before the institution type.
  /\b((?:[A-Z][\w'’.-]+\s+){1,4}University)\b/,
  /\b((?:[A-Z][\w'’.-]+\s+){1,3}Polytechnic)\b/,
  /\b((?:[A-Z][\w'’.-]+\s+){1,3}College of Education)\b/,
  /\b(Federal Polytechnic [A-Z][\w'’.-]+)\b/,
  /\b(Federal College of Education [A-Z][\w'’.-]+)\b/,
];

function countMatches(haystack: string, terms: string[]): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];
  for (const term of terms) {
    const t = term.toLowerCase();
    if (!t) continue;
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(t)}(?![a-z0-9])`, 'g');
    const hits = (haystack.match(re) || []).length;
    if (hits > 0) {
      matched.push(term);
      score += hits;
    }
  }
  return { score, matched };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Detect the institution an article is about. */
export function detectInstitution(text: string): string | null {
  const lower = text.toLowerCase();
  for (const inst of INSTITUTION_LOOKUP) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(inst.toLowerCase())}(?![a-z0-9])`);
    if (re.test(lower)) return inst;
  }
  for (const pattern of INSTITUTION_PATTERNS) {
    const m = text.match(pattern);
    if (!m || !m[1]) continue;
    const candidate = trimLeadingStopwords(m[1].trim());
    if (candidate.length <= 4) continue;
    if (candidate.split(/\s+/).length < 2) continue;
    return candidate;
  }
  return null;
}

export function detectCategory(text: string, fallback: string): string {
  const lower = text.toLowerCase();
  let best: { category: string; score: number } | null = null;
  for (const rule of CATEGORY_RULES) {
    const { score } = countMatches(lower, rule.terms);
    if (score > 0 && (!best || score > best.score)) {
      best = { category: rule.category, score };
    }
  }
  return best ? best.category : fallback;
}

export function detectCountry(text: string, fallback: string): string {
  const lower = text.toLowerCase();
  if (countMatches(lower, ['ghana', 'kenya', 'south africa', 'united kingdom', 'usa', 'canada', 'australia']).score >
      countMatches(lower, NIGERIA_TERMS).score) {
    return fallback;
  }
  return fallback;
}

export interface ClassifyInput {
  title: string;
  excerpt: string;
  content: string;
  /** Feed-provided categories, used as a weak signal. */
  feedCategories?: string[];
  /** Fallback category declared by the source. */
  defaultCategory: string;
  /** How strict to be about relevance. */
  focus: 'education' | 'general' | 'authority';
  country: string;
}

/**
 * Score an article for relevance and derive its metadata.
 *
 * Education-focused publishers only need a light relevance check (they exist
 * to cover education). General newspapers must clear a higher bar, because a
 * single feed mixes politics, sport and education.
 */
export function classify(input: ClassifyInput): Classification {
  // Defensive: callers sometimes pass feed categories that are objects.
  const safe = (v: unknown): string => (typeof v === 'string' ? v : '');
  const haystack = [
    safe(input.title),
    safe(input.excerpt),
    safe(input.content),
    ...(input.feedCategories ?? []).map(safe),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const titleLower = safe(input.title).toLowerCase();

  // ── Veto: obvious spam / off-topic ──────────────────────────────────────
  const blocked = countMatches(haystack, BLOCKLIST);
  const tertiary = countMatches(haystack, TERTIARY_TERMS);
  const education = countMatches(haystack, EDUCATION_TERMS);
  const nigeria = countMatches(haystack, NIGERIA_TERMS);

  const relevanceScore =
    tertiary.score * 3 + education.score * 1 + (nigeria.score > 0 ? 2 : 0) + (tertiary.matched.length > 0 ? 2 : 0);

  let relevant: boolean;
  if (blocked.score > 0 && tertiary.score === 0) {
    relevant = false;
  } else if (input.focus === 'authority') {
    // Regulators publish only education material; accept almost everything.
    relevant = blocked.score === 0 || tertiary.score > 0;
  } else if (input.focus === 'education') {
    relevant = tertiary.score > 0 || education.score >= 2 || (blocked.score === 0 && education.score >= 1);
    // A specialist publisher with an education feed category is on-topic.
    if (
      !relevant &&
      (input.feedCategories ?? []).some((c) =>
        /educat|admission|scholar|campus|school|jamb|utme/i.test(typeof c === 'string' ? c : ''),
      )
    ) {
      relevant = true;
    }
  } else {
    // General newspaper: require a real tertiary/education signal.
    const titleSignal = countMatches(titleLower, [...TERTIARY_TERMS, ...EDUCATION_TERMS]).score;
    relevant = tertiary.score >= 1 || titleSignal >= 1 || education.score >= 3;
    if (blocked.score > 0 && tertiary.score === 0) relevant = false;
  }

  const category = detectCategory(`${input.title} ${input.excerpt}`, input.defaultCategory);
  const institution =
    detectInstitution(`${input.title} ${input.excerpt}`) ??
    detectInstitution(input.content.slice(0, 4000)) ??
    null;

  const tags = [...new Set([...tertiary.matched, ...education.matched])].slice(0, 12);

  return {
    category,
    institution,
    country: detectCountry(haystack, input.country),
    relevant,
    relevanceScore,
    matchedTerms: [...new Set([...tertiary.matched, ...education.matched])].slice(0, 20),
    tags,
  };
}

/** Content quality gate used to set `is_verified`. */
export function isVerifiable(opts: {
  contentChars: number;
  minChars: number;
  extraction: string;
  tier: 'authority' | 'national' | 'specialist';
  publishedWithinWindow: boolean;
}): boolean {
  if (!opts.publishedWithinWindow) return false;
  if (opts.contentChars < opts.minChars) return false;
  if (opts.extraction === 'excerpt_only' && opts.tier !== 'authority') return false;
  return true;
}
