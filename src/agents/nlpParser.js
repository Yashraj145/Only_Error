/**
 * Simple keyword/regex-based NLP parser for natural language reports.
 */

/**
 * Parses free-text reports to extract structured disaster data.
 * @param {string} text - The natural language report text.
 * @returns {Object} Parsed data, confidence score, and extraction details.
 */
export function parseNaturalReport(text) {
  const original_text = text;
  const lowerText = text.toLowerCase();
  
  let location_match = null;
  let location = null;
  let name = null;
  
  // Location Regex Patterns
  const locPatterns = [
    /in\s+([A-Z][a-zA-Z0-9\s]+?)(?:,|\.|\s+(?:around|need|urgently|with|where)|$)/i,
    /at\s+([A-Z][a-zA-Z0-9\s]+?)(?:,|\.|\s+(?:around|need|urgently|with|where)|$)/i,
    /([A-Z][a-zA-Z0-9\s]+?)\s+area/i,
    /([A-Z][a-zA-Z0-9\s]+?)\s+district/i,
    /(ward\s+\d+)/i,
    /(sector\s+\d+)/i,
    /(block\s+\d+)/i
  ];

  for (const pattern of locPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      location_match = match[0];
      name = match[1].trim();
      location = name;
      break;
    }
  }

  // Population Regex Patterns
  let population_match = null;
  let population_affected = 0;
  const popPattern = /(\d+)\s+(people|persons|families|residents|affected|stranded|trapped)/i;
  const popMatch = text.match(popPattern);
  
  if (popMatch) {
    population_match = popMatch[0];
    let num = parseInt(popMatch[1], 10);
    if (popMatch[2].toLowerCase() === 'families') {
      num *= 4;
    }
    population_affected = num;
  }

  // Needs extraction
  const needs_matches = [];
  const needs = [];
  
  const categories = {
    water: ['water', 'drinking', 'dehydration', 'thirst'],
    medical: ['medical', 'medicine', 'injured', 'hospital', 'health', 'doctor', 'first aid'],
    food: ['food', 'hungry', 'starving', 'rations', 'meals', 'supplies'],
    shelter: ['shelter', 'homeless', 'displaced', 'tents', 'housing', 'roof'],
    rescue: ['rescue', 'stranded', 'trapped', 'stuck', 'boats', 'evacuate', 'evacuation']
  };

  for (const [category, keywords] of Object.entries(categories)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        if (!needs.includes(category)) {
          needs.push(category);
        }
        needs_matches.push(keyword);
      }
    }
  }

  // Urgency extraction
  const urgencyKeywords = ['urgent', 'urgently', 'critical', 'emergency', 'immediate', 'immediately', 'desperate', 'dire', 'sos'];
  const urgency_signals = urgencyKeywords.filter(k => lowerText.includes(k));
  const urgency_high = urgency_signals.length > 0;

  // Rescue extraction
  const rescueKeywords = ['rescue', 'stranded', 'trapped', 'stuck', 'marooned', 'boats needed'];
  const rescue_signals = rescueKeywords.filter(k => lowerText.includes(k));
  const rescue_needed = rescue_signals.length > 0;

  // Confidence calculation
  let extractedFields = 0;
  const totalFields = 4; // location, population, needs, urgency/rescue context
  
  if (location) extractedFields++;
  if (population_affected > 0) extractedFields++;
  if (needs.length > 0) extractedFields++;
  if (urgency_high || rescue_needed) extractedFields++;
  
  let confidence = extractedFields / totalFields;
  confidence = Math.min(Math.max(confidence, 0), 1); // clamp 0-1

  return {
    parsed: {
      name: name || 'Unknown Location',
      location: location || 'Unknown Location',
      population_affected,
      needs,
      rescue_needed,
      urgency_high
    },
    confidence,
    extraction_details: {
      location_match,
      population_match,
      needs_matches: [...new Set(needs_matches)],
      urgency_signals,
      rescue_signals
    },
    original_text
  };
}
