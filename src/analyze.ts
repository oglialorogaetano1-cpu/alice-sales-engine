import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT_TEMPLATE = `Sei un analista esperto di trattative di vendita. Ricevi la trascrizione di una videocall tra un nostro venditore e un potenziale cliente, con i nomi degli speaker, e il contesto della nostra azienda. Analizza la trattativa in modo onesto e concreto, senza adulazione: lo scopo è aiutare il venditore a migliorare e il manager a capire cosa funziona.
CONTESTO AZIENDALE:
{CONTESTO_AZIENDALE}
Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo e senza backtick, con questa struttura esatta:
{
"riassunto": "2-3 frasi su come è andata",
"stato_trattativa": "chiusa_vinta | promettente | incerta | a_rischio | persa",
"voto_totale": numero 1-10,
"punteggi": {
"apertura_rapport": 1-10,
"scoperta_esigenze": 1-10,
"presentazione_valore": 1-10,
"gestione_obiezioni": 1-10,
"chiusura_next_step": 1-10,
"ascolto_tono": 1-10
},
"pacchetto_proposto": "quale pacchetto ha proposto il venditore, o 'nessuno'",
"note_offerta": "se ha scontato o offerto qualcosa di non coerente con le regole aziendali, segnalalo; altrimenti 'ok'",
"punti_di_forza": ["punto concreto", "punto concreto"],
"errori_da_correggere": ["errore concreto", "errore concreto"],
"obiezioni_emerse": ["obiezione", "obiezione"],
"prossimo_passo_consigliato": "cosa dovrebbe fare ora il venditore",
"frase_coaching": "una frase diretta e pratica di coaching per il venditore"
}
Regole: basati SOLO sulla trascrizione, non inventare nulla. Se è troppo corta per giudicare una voce, dai un punteggio prudente e segnalalo nel riassunto. Tutto in italiano.`;

export type AnalisiChiamata = {
  riassunto: string;
  stato_trattativa: string;
  voto_totale: number;
  punteggi: Record<string, number>;
  pacchetto_proposto: string;
  note_offerta: string;
  punti_di_forza: string[];
  errori_da_correggere: string[];
  obiezioni_emerse: string[];
  prossimo_passo_consigliato: string;
  frase_coaching: string;
};

export async function analyzeCall(transcript: string, contestoAziendale: string): Promise<AnalisiChiamata> {
  const client = new Anthropic();
  const system = SYSTEM_PROMPT_TEMPLATE.replace('{CONTESTO_AZIENDALE}', contestoAziendale);

  const msg = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: `TRASCRIZIONE:\n${transcript}` }],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  return JSON.parse(text) as AnalisiChiamata;
}
