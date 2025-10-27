// ai-client.js

// --- Constants ---
const LANGUAGES = {
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'nl': 'Dutch',
  'it': 'Italian',
  'pt': 'Portuguese',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh': 'Chinese',
  'ru': 'Russian',
  'ar': 'Arabic',
  'hi': 'Hindi',
};


const UNIFIED_SYSTEM_PROMPT = `You are an expert and friendly language tutor for the "TransLearn" browser extension. Your goal is to help an intermediate learner understand and learn from any text. You will be given a specific task in the user prompt. Follow that task precisely and respond only in the format requested.`;


// --- Core API Functions ---

/**
 * Detects the language of a given text string.
 * @param {string} text The text to analyze.
 * @returns {Promise<string|null>} The detected language code or null.
 */
async function detectLanguage(text) {
    if (!('LanguageDetector' in self)) {
      console.error("AI Client: LanguageDetector API not available.");
      return null;
    }
    try {
      const detector = await LanguageDetector.create();
      const results = await detector.detect(text);
      if (results.length > 0 && results[0].confidence > 0.6) {
        return results[0].detectedLanguage;
      }
      return null;
    } catch (error) {
      console.error("AI Client: Error during language detection:", error);
      return null;
    }
}

/**
 * Translates text, handling language detection, mismatches, and cancellation.
 * @param {string} text The source text.
 * @param {string} userSourceLang The user's chosen source language ('auto' or a code).
 * @param {string} userTargetLang The user's chosen target language.
 * @param {AbortSignal} signal An AbortSignal to cancel the request.
 * @returns {Promise<object>} A result object with translatedText, detectedLang, and warning.
 */
async function translateText(text, userSourceLang, userTargetLang, signal) {
  if (!('Translator' in self)) {
    return { translatedText: "Error: Translator API not available.", detectedLang: null, warning: null };
  }

  const detectedLang = await detectLanguage(text);

  if (userSourceLang !== 'auto' && detectedLang && detectedLang !== userSourceLang) {
    const warningMessage = `This looks like ${LANGUAGES[detectedLang] || detectedLang.toUpperCase()}. Your 'Translate from' is set to ${LANGUAGES[userSourceLang] || userSourceLang.toUpperCase()}.`;
    return {
      translatedText: "Translation paused due to language mismatch.",
      detectedLang: detectedLang,
      warning: warningMessage
    };
  }

  let sourceLangForTranslation = userSourceLang === 'auto' ? detectedLang : userSourceLang;

  if (!sourceLangForTranslation) {
    return { translatedText: "Error: Could not determine source language.", detectedLang: null, warning: null };
  }

  if (sourceLangForTranslation === userTargetLang) {
    return { translatedText: text, detectedLang: sourceLangForTranslation, warning: null };
  }

  try {
    const translator = await Translator.create({
      sourceLanguage: sourceLangForTranslation,
      targetLanguage: userTargetLang,
      signal: signal,
    });
    const result = await translator.translate(text);
    return {
      translatedText: result,
      detectedLang: detectedLang || sourceLangForTranslation,
      warning: null
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { translatedText: "", detectedLang: null, warning: null };
    }
    return { translatedText: `Error: Translation failed. ${error.message}`, detectedLang: detectedLang, warning: null };
  }
}

/**
 * Acts as a "language tutor" to identify and analyze the most valuable vocabulary
 * using a robust two-step prompt chain.
 */
async function getVocabulary(sourceText, translatedText, sourceLang, targetLang, onInitialWords, onLine, signal) {
  console.log(`AI Client: Starting 3-step "Assembly Line" vocabulary analysis...`);

  try {
    const session = await promptManager.getSession(signal);
    if (!session) throw new Error("Prompt session is not available.");

    // --- STEP 1: EXTRACT ---
    const extractorUserPrompt = `SOURCE TEXT: "${sourceText}"\n\nTASK: Extract the key learning vocabulary from the SOURCE TEXT, appropriate for an intermediate language learner, as a comma-separated list. The word or words in your list MUST be identical to their corresponding word in the SOURCE TEXT even on plurality (If a word is of plural type in SOURCE TEXT, give it as the plural type). In your selection of key words, IGNORE all proper nouns (names, places, countries, cities, brands like "Google"), common words (articles, pronouns, simple prepositions), and numbers, dates, and month names. Respond ONLY with the comma-separated list.`;
    
    console.log("AI Client: Step 1 - Extracting key words...");
    const rawWordsList = await session.prompt([
      { role: 'system', content: UNIFIED_SYSTEM_PROMPT },
      { role: 'user', content: extractorUserPrompt }
    ]);
    if (!rawWordsList) throw new Error("Extractor task failed.");

    // --- JAVASCRIPT CLEANING STEP ---
    const cleanSourceWords = rawWordsList
      .split(',')
      .map(w => w.trim().replace(/[.,;:]$/, '')) // Remove trailing punctuation
      .filter(Boolean);
    console.log("AI Client: Step 1 - Cleaned words:", cleanSourceWords);

    // Immediately call the callback for the initial highlight.
    if (onInitialWords) {
      onInitialWords(cleanSourceWords);
    }
    if (cleanSourceWords.length === 0) return; // Stop if no words were found

    // --- STEP 2: ANALYZE PART OF SPEECH (POS) ---
    const posAnalyzerUserPrompt = `TASK: For each word in the following comma-separated list, provide its part of speech (noun, verb, adjective, or adverb). The words in your response MUST be IDENTICAL to their original word in the list. Do not change it. Respond ONLY with lines in the format: word | part_of_speech`;
    const posWordsToAnalyze = cleanSourceWords.join(', ');

    console.log("AI Client: Step 2 - Analyzing Part of Speech...");
    const posResultString = await session.prompt([
        { role: 'system', content: UNIFIED_SYSTEM_PROMPT },
        { role: 'user', content: `${posAnalyzerUserPrompt}\n\nWORDS: "${posWordsToAnalyze}"` }
    ]);
    const posMap = new Map(posResultString.split('\n').map(line => {
        const parts = line.split('|').map(s => s.trim());
        return parts.length === 2 ? [parts[0].toLowerCase(), parts[1]] : null;
    }).filter(Boolean));
    console.log("AI Client: Step 2 - POS map created:", posMap);

    // --- STEP 3: TRANSLATE (using the reliable Translator API) ---
    console.log("AI Client: Step 3 - Batch translating words...");
    const translatedWords = await batchTranslate(cleanSourceWords, sourceLang, targetLang, signal);
    console.log("AI Client: Step 3 - Translated words:", translatedWords);

    // --- FINAL ASSEMBLY & STREAMING ---
    // Now that we have all the data, combine it and stream it to the UI.
    const finalVocabulary = [];
    for (let i = 0; i < cleanSourceWords.length; i++) {
      const sourceWord = cleanSourceWords[i];
      const pos = posMap.get(sourceWord.toLowerCase()) || 'word';
      const translatedWord = translatedWords[i];

      if (sourceWord && pos && translatedWord) {
        const vocabData = { sourceWord, pos, translatedWord };
        finalVocabulary.push(vocabData);
        // Call the onLine callback to stream the perfect, complete data.
        onLine(`${sourceWord} | ${pos} | ${translatedWord}`);
      }
    }

    return {
      finalVocabulary: finalVocabulary,
      initialWords: cleanSourceWords
  };

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log("AI Client: Vocabulary stream was aborted.");
    } else {
      console.error(`AI Client: Error during 3-step vocabulary breakdown:`, error);
    }
  }
}

/**
 * Gets a detailed, dictionary-style breakdown for a single word, streaming the result.
 */
async function getWordDetails(word, sourceLang, targetLang, onChunk, signal) {
  console.log(`AI Client: Requesting deep dive stream for word: "${word}"`);

  try {
    const session = await promptManager.getSession(signal);
    if (!session) throw new Error("Prompt session is not available.");

//     const systemPrompt = `You are a language dictionary assistant. For the user's word, provide a detailed breakdown using simple Markdown.
// Follow these rules EXACTLY:
// 1.  Start DIRECTLY with the **Definition**. Do NOT repeat the word.
// 2.  The **Definition** MUST be in the TARGET language.
// 3.  Provide one **Example Sentence** using the word in the SOURCE language.
// 4.  Provide the **Example Translation** for that sentence in the TARGET language.
// 5.  Provide a list of **Synonyms**. The synonyms MUST be in the SOURCE language.
// 6.  If the word is a VERB, provide its **Principal Parts**. Do NOT provide conjugations for non-verbs.`;

    const userPrompt = `WORD: "${word}" (SOURCE: ${LANGUAGES[sourceLang] || sourceLang})
Provide details in ${LANGUAGES[targetLang] || targetLang} (TARGET).

TASK: Provide a detailed dictionary-style breakdown for the WORD using simple Markdown.
Follow these rules EXACTLY:
1.  Start DIRECTLY with the **Definition** in the TARGET language. Don't repeat the word in the beginning of your response.
2.  Provide one **Example Sentence** in the SOURCE language at intermediate level. Don't give the sentence meaning yet.
3.  Provide the **Example Translation** in the TARGET language.
4.  Provide a list of **Synonyms** of the WORD in the SOURCE language.
5.  If the word is a VERB, provide its **Principal Parts**. If it is not, don't give this **Principal Parts** section.`;

    return await streamForTypingEffect(session, UNIFIED_SYSTEM_PROMPT, userPrompt, onChunk, signal);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log("AI Client: Deep dive request was aborted.");
    } else {
      console.error("AI Client: Error during getWordDetails:", error);
    }
    return null;
  }
}

/**
 * Simplifies a sentence to a specific CEFR level in its original language.
 */
async function simplifyText(text, sourceLang, level, onChunk, signal) {
  console.log(`AI Client: Requesting simplification to CEFR level ${level}...`);

  try {
    const session = await promptManager.getSession(signal);
    if (!session) throw new Error("Prompt session is not available.");

    const systemPrompt = `You are a language teaching assistant. Your task is to rewrite a sentence in its original language to make it easier to understand for a language learner at a specific CEFR level.
- Use simpler vocabulary and sentence structures appropriate for the target level.
- Do NOT translate the text.
- Do NOT add any explanations or comments.
- Respond ONLY with the rewritten text.`;

    const userPrompt = `Original Text (in ${LANGUAGES[sourceLang] || sourceLang}): "${text}"
Rewrite this text to a ${level} CEFR level.`;

    return await streamForTypingEffect(session, systemPrompt, userPrompt, onChunk, signal);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log("AI Client: Simplification request was aborted.");
    } else {
      console.error(`AI Client: Error during CEFR simplification:`, error);
    }
    onChunk(text); // Fallback to original text on error
    return text;
  }
}


// --- Streaming Helpers ---

async function streamAndGetResponse(session, systemPrompt, userPrompt, onLine, signal) {
  const stream = session.promptStreaming([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]);

  let fullResponse = "";
  let lineBuffer = "";

  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      fullResponse += chunk;
      lineBuffer += chunk;
      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
        const completeLine = lineBuffer.substring(0, newlineIndex).trim();
        lineBuffer = lineBuffer.substring(newlineIndex + 1);
        if (completeLine) {
          onLine(completeLine);
        }
      }
    }
    if (lineBuffer.trim()) {
      onLine(lineBuffer.trim());
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log("AI stream (line-by-line) was aborted.");
      throw error;
    }
    console.error("Error during stream processing:", error);
  }
  return fullResponse;
}

async function streamForTypingEffect(session, systemPrompt, userPrompt, onChunk, signal) {
  const stream = session.promptStreaming([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]);

  let fullResponse = "";
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      fullResponse += chunk;
      onChunk(chunk);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log("AI stream (typing effect) was aborted.");
      throw error;
    }
    console.error("Error during typing stream:", error);
  }
  return fullResponse;
}


// We will reuse our robust batch translation logic.
async function batchTranslate(words, sourceLang, targetLang, signal) {
  if (words.length === 0) return [];

  const separator = "|";
  const joinedText = words.join(separator);
  // const separator = "\n<|>\n";
  // const joinedText = words.join(separator);
  const result = await translateText(joinedText, sourceLang, targetLang, signal);
  if (result.warning || result.translatedText.startsWith("Error:")) {
    console.error("Batch translation failed:", result.translatedText || result.warning);
    return words.map(() => "n/a");
  }
  // return result.translatedText.split(separator.trim());

  // This removes any extra spaces the API might have added.
  const translatedWords = result.translatedText.split(separator).map(word => word.trim());
  // --- END FIX ---

  // Final safety check to ensure the arrays are the same length.
  if (translatedWords.length !== words.length) {
    console.error("Batch translation returned a different number of words. Falling back.");
    // As a fallback, translate one by one (slower but safer).
    const fallbackTranslations = [];
    for (const word of words) {
      const singleResult = await translateText(word, sourceLang, targetLang, signal);
      fallbackTranslations.push(singleResult.translatedText.trim());
    }
    return fallbackTranslations;
  }

  return translatedWords;
}