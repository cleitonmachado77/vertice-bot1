import { completeChat } from './agent.js';
import { getSetting } from './db.js';

export type MediaUnderstanding = {
  type: string;
  summary: string;
  transcript: string;
  caption: string;
  mediaUrl: string;
  understood: boolean;
};

/** Interpreta texto, áudio, imagem ou vídeo para o agente de questionário. */
export async function understandInbound(input: {
  type: string;
  text: string;
  mediaUrl: string;
}): Promise<MediaUnderstanding> {
  const type = normalizeMediaType(input.type);
  const caption = input.text.trim();
  const mediaUrl = input.mediaUrl.trim();

  if (type === 'text') {
    return {
      type,
      summary: caption,
      transcript: caption,
      caption,
      mediaUrl: '',
      understood: Boolean(caption),
    };
  }

  if (type === 'audio' && mediaUrl) {
    const transcript = await transcribeAudio(mediaUrl);
    if (transcript) {
      return {
        type,
        summary: transcript,
        transcript,
        caption,
        mediaUrl,
        understood: true,
      };
    }
    return {
      type,
      summary: caption || 'Áudio recebido (sem transcrição disponível).',
      transcript: '',
      caption,
      mediaUrl,
      understood: false,
    };
  }

  if (type === 'image' && mediaUrl) {
    const description = await describeImage(mediaUrl, caption);
    if (description) {
      return {
        type,
        summary: description,
        transcript: description,
        caption,
        mediaUrl,
        understood: true,
      };
    }
    return {
      type,
      summary: caption || 'Imagem recebida.',
      transcript: caption,
      caption,
      mediaUrl,
      understood: Boolean(caption),
    };
  }

  if (type === 'video' && mediaUrl) {
    const description = caption
      ? `Vídeo recebido. Legenda: ${caption}`
      : 'Vídeo recebido como resposta.';
    return {
      type,
      summary: description,
      transcript: caption,
      caption,
      mediaUrl,
      understood: true,
    };
  }

  return {
    type,
    summary: caption || `${type} recebido.`,
    transcript: caption,
    caption,
    mediaUrl,
    understood: Boolean(caption || mediaUrl),
  };
}

export function normalizeMediaType(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes('audio') || lower.includes('voice') || lower === 'ptt') return 'audio';
  if (lower.includes('image') || lower.includes('img') || lower.includes('foto') || lower.includes('sticker')) {
    return 'image';
  }
  if (lower.includes('video')) return 'video';
  if (lower.includes('document') || lower.includes('file')) return 'document';
  return 'text';
}

async function transcribeAudio(mediaUrl: string): Promise<string> {
  const apiKey = getSetting('agent_api_key');
  if (!apiKey || !mediaUrl) return '';
  try {
    const media = await fetch(mediaUrl, { signal: AbortSignal.timeout(25_000) });
    if (!media.ok) return '';
    const bytes = Buffer.from(await media.arrayBuffer());
    if (!bytes.length) return '';
    const contentType = media.headers.get('content-type') || 'audio/ogg';
    const extension = extensionFor(contentType, mediaUrl);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: contentType }),
      `audio.${extension}`,
    );
    form.append('model', getSetting('agent_transcribe_model', 'whisper-1'));
    form.append('language', 'pt');

    const base = getSetting('agent_base_url').replace(/\/$/, '');
    const response = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    const payload = (await response.json()) as { text?: string; error?: { message?: string } };
    if (!response.ok) {
      console.error(`transcrição: ${payload.error?.message || response.status}`);
      return '';
    }
    return String(payload.text || '').trim();
  } catch (error) {
    console.error(`transcrição: ${error instanceof Error ? error.message : error}`);
    return '';
  }
}

async function describeImage(mediaUrl: string, caption: string): Promise<string> {
  const apiKey = getSetting('agent_api_key');
  if (!apiKey || !mediaUrl) return '';
  try {
    const prompt = [
      'Descreva em português do Brasil, de forma objetiva, o conteúdo desta imagem enviada como resposta de questionário.',
      'Se houver texto legível, transcreva.',
      caption ? `Legenda do usuário: ${caption}` : '',
      'Responda só com a descrição, sem introduções.',
    ]
      .filter(Boolean)
      .join('\n');

    return await completeChat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: mediaUrl } },
          ],
        },
      ],
      { temperature: 0.2, timeoutMs: 40_000 },
    );
  } catch (error) {
    console.error(`visão: ${error instanceof Error ? error.message : error}`);
    return caption;
  }
}

function extensionFor(contentType: string, url: string): string {
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('webm')) return 'webm';
  if (contentType.includes('ogg') || contentType.includes('opus')) return 'ogg';
  const fromUrl = /\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1];
  return fromUrl || 'ogg';
}
