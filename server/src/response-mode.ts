export type ResponseMode = 'factual' | 'synthesis';

export function classifyResponseMode(request: string): ResponseMode {
  return /(?:^|[^\p{L}\p{N}_])(состав(?:ь|ить|ьте)?|подготов(?:ь|ить|ьте)?|сформир(?:уй|овать|уйте)?|предлож(?:и|ить|ите)?|разработ(?:ай|ать|айте)?|итогов(?:ый|ую|ое)|дорожн(?:ая|ую) карт(?:а|у)|план действий|рекомендаци(?:я|и|ю)|plan|recommendation)(?=$|[^\p{L}\p{N}_])/iu.test(request)
    ? 'synthesis'
    : 'factual';
}

export function hasContextReference(request: string) {
  return /(?:^|[^\p{L}\p{N}_])(этот|эта|это|эти|этого|этой|этом|этому|такой|такая|такое|такие|вариант(?:а|е|ом|ы)?|он|она|они)(?=$|[^\p{L}\p{N}_])/iu.test(request);
}

export function requiresDocumentGrounding(request: string, hasAttachedDocuments = false) {
  if (hasAttachedDocuments) return true;
  return /(?:^|[^\p{L}\p{N}_])(?:по документ(?:у|ам|е|ах)?|в документ(?:е|ах)?|из документ(?:а|ов)?|по файл(?:у|ам)?|в файл(?:е|ах)?|из файл(?:а|ов)?|согласно (?:документ(?:у|ам)?|файл(?:у|ам)?|материал(?:у|ам)?)|в загруженн(?:ом|ых) (?:документ(?:е|ах)?|файл(?:е|ах)?)|по загруженн(?:ому|ым) (?:документ(?:у|ам)?|файл(?:у|ам)?)|в базе знаний|по базе знаний|в материалах|по материалам|приведи цитат|процитируй|укажи источник)(?=$|[^\p{L}\p{N}_])/iu.test(request);
}
