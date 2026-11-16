/**
 * Florida 24 - Newsletter Category & Subcategory Hierarchical Mapping Service
 *
 * Implements requirement 1 & 6:
 * - Smart category-matching system for newsletter subscriptions.
 * - Resolves the approved article's main category (or maps any subcategory to its parent main category).
 * - STRICT MATCHING: Send notification ONLY to subscribers whose selected categories match
 *   the approved article's resolved main category.
 * - Non-matching subscribers are strictly excluded.
 */

export interface CategoryHierarchy {
  id: string;
  name: string;
  subcategories: string[];
}

export const CATEGORY_HIERARCHY: CategoryHierarchy[] = [
  {
    id: "world",
    name: "World",
    subcategories: [
      "China",
      "United States",
      "Europe",
      "Britain",
      "Middle East",
      "Africa",
      "Asia",
      "Interview",
    ],
  },
  {
    id: "companies",
    name: "Companies",
    subcategories: [
      "Corporate Announcements",
      "Mergers & Acquisitions",
      "Leadership Changes",
    ],
  },
  {
    id: "startups",
    name: "Startups",
    subcategories: [
      "Funding & Investment",
      "Founder Stories",
      "Venture Capital",
      "Startup Failures",
    ],
  },
  {
    id: "markets",
    name: "Markets",
    subcategories: ["Stock Market", "Bonds", "Mutual Funds"],
  },
  {
    id: "economy",
    name: "Economy",
    subcategories: [
      "GDP & Economic Growth",
      "Employment",
      "Government Economic Policies",
    ],
  },
  {
    id: "finance",
    name: "Finance",
    subcategories: [
      "Digital Banking",
      "FinTech",
      "Banking Industry",
      "Loans & Lending",
    ],
  },
  {
    id: "technology",
    name: "Technology",
    subcategories: [
      "Artificial Intelligence",
      "Cybersecurity",
      "Gadgets & Devices",
      "Software",
      "Startups",
    ],
  },
  {
    id: "industries",
    name: "Industries",
    subcategories: [
      "Manufacturing",
      "Energy",
      "Pharmaceuticals",
      "Automobile",
      "Agriculture Business",
      "Construction",
      "Design",
      "Textiles",
      "Entertainment",
    ],
  },
  {
    id: "leaders",
    name: "Leaders",
    subcategories: [
      "Business Leaders",
      "CEO Interviews",
      "Executive Appointments",
      "Leadership Strategies",
    ],
  },
  {
    id: "sports",
    name: "Sports",
    subcategories: [
      "Cricket",
      "Football",
      "Basketball",
      "Tennis",
      "Baseball",
      "Hockey",
      "Golf",
      "Olympics",
      "Motorsports",
      "Soccer",
      "Rugby",
    ],
  },
  {
    id: "politics",
    name: "Politics",
    subcategories: [
      "Elections",
      "Congress",
      "White House",
      "Government",
      "Policy",
      "Judiciary",
    ],
  },
  {
    id: "entertainment",
    name: "Entertainment",
    subcategories: [
      "Movies",
      "Television",
      "Music",
      "Culture",
      "Celebrity",
      "Arts",
      "Books",
    ],
  },
];

/**
 * Normalizes any category or subcategory name for robust comparison.
 * Lowercases, trims, and collapses dashes/underscores/spaces.
 */
export function normalizeCategoryName(cat: string): string {
  if (!cat) return "";
  return cat
    .toLowerCase()
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Fast lookup map from normalized subcategory / alias -> Canonical Parent Main Category Name.
 */
const subcategoryToParentMap = new Map<string, string>();

CATEGORY_HIERARCHY.forEach((mainCat) => {
  const normMain = normalizeCategoryName(mainCat.name);
  const normId = normalizeCategoryName(mainCat.id);

  // Main category maps to itself
  subcategoryToParentMap.set(normMain, mainCat.name);
  subcategoryToParentMap.set(normId, mainCat.name);

  // Subcategories map to this main category
  mainCat.subcategories.forEach((sub) => {
    const normSub = normalizeCategoryName(sub);
    subcategoryToParentMap.set(normSub, mainCat.name);
  });
});

// Explicit aliases for singular / plural and common variations
const COMMON_ALIASES: Record<string, string> = {
  company: "Companies",
  companies: "Companies",
  mcompany: "Companies",
  corporate: "Companies",
  startup: "Startups",
  startups: "Startups",
  market: "Markets",
  markets: "Markets",
  economy: "Economy",
  economic: "Economy",
  finance: "Finance",
  financial: "Finance",
  technology: "Technology",
  tech: "Technology",
  industry: "Industries",
  industries: "Industries",
  leader: "Leaders",
  leaders: "Leaders",
  leadership: "Leaders",
  sport: "Sports",
  sports: "Sports",
  politic: "Politics",
  politics: "Politics",
  political: "Politics",
  entertainment: "Entertainment",
};

Object.entries(COMMON_ALIASES).forEach(([alias, parent]) => {
  subcategoryToParentMap.set(normalizeCategoryName(alias), parent);
});

/**
 * Resolves any category or subcategory name to its canonical Parent Main Category Name.
 * If the input is already a main category, returns its canonical title (e.g. "Sports", "Companies").
 * If the input is a subcategory (e.g. "Cricket", "FinTech", "China"), returns its parent (e.g. "Sports", "Finance", "World").
 * If it's an unrecognized category, returns the title-cased input.
 */
export function resolveParentCategory(rawCategory: string): string {
  if (!rawCategory) return "World";
  const normalized = normalizeCategoryName(rawCategory);

  // 1. Direct exact lookup
  if (subcategoryToParentMap.has(normalized)) {
    return subcategoryToParentMap.get(normalized)!;
  }

  // 2. Whole word boundary match (prevents false substring collisions)
  for (const [subNorm, parentName] of subcategoryToParentMap.entries()) {
    if (subNorm.length >= 4) {
      // Escape special regex characters in subNorm
      const escaped = subNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(normalized)) {
        return parentName;
      }
    }
  }

  // Fallback: Return original string properly capitalized
  return rawCategory.charAt(0).toUpperCase() + rawCategory.slice(1);
}

/**
 * Resolves the approved article's primary main category.
 * If the admin selected a main category, returns that main category.
 * If the admin selected a subcategory, resolves and returns its parent main category.
 */
export function getApprovedArticleMainCategory(category: string): string {
  if (!category || !category.trim()) return "World";
  return resolveParentCategory(category.trim());
}

/**
 * STRICT CATEGORY MATCHING (Requirements 1 & 6):
 * Checks whether a subscriber's selected newsletter preferences match the approved article's main category.
 *
 * Rules:
 * - Send email ONLY to subscribers who selected the exact same main category as the approved article (or its parent).
 * - If the subscriber did not select the matching category, returns false (no email).
 *
 * @param subscriberNewsletters Comma-separated or array of subscriber preferences (e.g. "World, Startups, Markets")
 * @param articleMainCategory Resolved parent main category of the approved article (e.g. "Companies")
 */
export function isSubscriberMatch(
  subscriberNewsletters: string | string[],
  articleMainCategory: string
): boolean {
  if (!subscriberNewsletters || !articleMainCategory) {
    return false;
  }

  let selectedList: string[] = [];
  if (Array.isArray(subscriberNewsletters)) {
    selectedList = subscriberNewsletters;
  } else {
    selectedList = subscriberNewsletters
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const targetCategoryCanonical = resolveParentCategory(articleMainCategory);
  const targetCategoryNormalized = normalizeCategoryName(targetCategoryCanonical);

  return selectedList.some((subscriberPref) => {
    const prefCanonical = resolveParentCategory(subscriberPref);
    const prefNormalized = normalizeCategoryName(prefCanonical);
    return prefNormalized === targetCategoryNormalized;
  });
}
