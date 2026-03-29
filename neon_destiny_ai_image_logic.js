// ============================================================
//   NEON DESTINY : AI IMAGE LOGIC & WORKFLOW
//   Complete System Architecture for Webtoon Image Generation
//   Stack: Supabase + Stable Diffusion API + JavaScript
// ============================================================


// ============================================================
// SECTION 1 : PROMPT ASSEMBLY  (Character Consistency Engine)
// ============================================================
//
// KEY PRINCIPLE:
//   Character = Base Style + Face Preset + Hair Preset + Outfit + Action + Mood
//   ทุกรูปต้องเริ่มจาก "Base Style Anchor" เดิมเสมอ
//   เพื่อให้ AI คุมหน้าตาออกมาเหมือนเดิม 80-90%
//

const BASE_STYLE_ANCHOR = [
  "webtoon art style",
  "manhwa illustration",
  "Solo Leveling art style",
  "clean line art",
  "high detail shading",
  "dramatic lighting",
  "full body portrait",
  "white background"
].join(", ");

const NEGATIVE_PROMPT = [
  "realistic photo",
  "3d render",
  "blurry",
  "deformed",
  "extra limbs",
  "bad anatomy",
  "ugly",
  "watermark",
  "low quality",
  "anime chibi"
].join(", ");

/**
 * buildCharacterPrompt()
 * ดึงข้อมูล preset ของตัวละครจาก Supabase แล้วประกอบเป็น prompt เดียว
 *
 * @param {object} character - Character row from Supabase
 * @param {string} actionTag - สิ่งที่ตัวละครทำ เช่น "fighting boss", "entering dungeon"
 * @param {string} moodTag   - อารมณ์ เช่น "determined", "victorious", "injured"
 * @returns {string} Full assembled prompt
 */
async function buildCharacterPrompt(character, actionTag = "standing", moodTag = "neutral") {
  const { data: face }    = await supabase.from('face_presets').select('ai_prompt').eq('id', character.face_preset_id).single();
  const { data: hair }    = await supabase.from('hair_presets').select('ai_prompt').eq('id', character.hair_preset_id).single();
  const { data: outfit }  = await supabase.from('outfit_presets').select('ai_prompt').eq('id', character.outfit_preset_id).single();
  const { data: cls }     = await supabase.from('classes').select('name').eq('id', character.class_id).single();

  // Shadow Heir gets extra dark overlay
  const shadowBoost = character.is_shadow_heir
    ? ", shadow energy aura, neon red glow, shadow monarch presence"
    : "";

  const rankBoost = character.rank === 'S' || character.rank === 'National' || character.rank === 'Monarch'
    ? ", powerful aura radiating, top hunter presence"
    : "";

  const fullPrompt = [
    BASE_STYLE_ANCHOR,
    face.ai_prompt,
    hair.ai_prompt,
    outfit.ai_prompt,
    `${cls.name} class hunter`,
    `action: ${actionTag}`,
    `expression: ${moodTag}`,
    shadowBoost,
    rankBoost
  ].filter(Boolean).join(", ");

  return { prompt: fullPrompt, negativePrompt: NEGATIVE_PROMPT };
}


// ============================================================
// SECTION 2 : CACHE CHECK  (ประหยัด API quota สูงสุด)
// ============================================================
//
// Logic:
//   1. สร้าง Cache Key จากองค์ประกอบของรูป
//   2. เช็คใน Supabase Storage ก่อนเสมอ
//   3. ถ้ามีรูปแล้ว → return URL ทันที (ไม่เรียก AI)
//   4. ถ้าไม่มี → สร้างรูปใหม่ แล้ว upload เก็บไว้
//

/**
 * generateCacheKey()
 * รูปที่ action และ mood เดิมของตัวละครเดิม = ไฟล์เดิม
 */
function generateCacheKey(characterId, faceId, hairId, outfitId, actionTag, moodTag) {
  const components = [characterId, faceId, hairId, outfitId, actionTag, moodTag].join("_");
  // Simple hash function (ใน production ใช้ crypto.subtle.digest)
  let hash = 0;
  for (let i = 0; i < components.length; i++) {
    hash = ((hash << 5) - hash) + components.charCodeAt(i);
    hash |= 0;
  }
  return `char_${Math.abs(hash).toString(16)}`;
}

async function checkImageCache(cacheKey) {
  try {
    const { data } = await supabase.storage.from('webtoon-cache').getPublicUrl(`${cacheKey}.webp`);
    // ถ้าไฟล์มีอยู่จริงให้ return URL
    const response = await fetch(data.publicUrl, { method: 'HEAD' });
    if (response.ok) return data.publicUrl;
    return null;
  } catch {
    return null;
  }
}

async function saveImageToCache(cacheKey, imageBlob) {
  const { data, error } = await supabase.storage
    .from('webtoon-cache')
    .upload(`${cacheKey}.webp`, imageBlob, {
      contentType: 'image/webp',
      upsert: true,
      cacheControl: '2592000'  // 30 days
    });
  if (error) throw error;
  return supabase.storage.from('webtoon-cache').getPublicUrl(`${cacheKey}.webp`).data.publicUrl;
}


// ============================================================
// SECTION 3 : QUEUE SYSTEM  (รองรับ 1,000 users พร้อมกัน)
// ============================================================
//
// SQL TABLE ที่ต้องสร้างเพิ่มใน Supabase:
//
//   CREATE TABLE image_queue (
//     id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
//     char_id       UUID NOT NULL REFERENCES characters(id),
//     cache_key     VARCHAR(64) NOT NULL,
//     prompt        TEXT NOT NULL,
//     negative      TEXT,
//     status        VARCHAR(20) DEFAULT 'pending',  -- pending | processing | done | failed
//     priority      INT DEFAULT 5,                  -- 1=highest (CEO), 5=normal, 10=lowest
//     result_url    TEXT,
//     error_msg     TEXT,
//     attempts      INT DEFAULT 0,
//     created_at    TIMESTAMPTZ DEFAULT NOW(),
//     processed_at  TIMESTAMPTZ,
//     UNIQUE(cache_key)
//   );
//
//   CREATE INDEX idx_queue_status   ON image_queue(status, priority, created_at);
//   CREATE INDEX idx_queue_char     ON image_queue(char_id, status);
//

/**
 * enqueueImageRequest()
 * ใส่คำขอสร้างรูปเข้าคิว — ไม่ block UI
 */
async function enqueueImageRequest(character, actionTag, moodTag) {
  const { prompt, negativePrompt } = await buildCharacterPrompt(character, actionTag, moodTag);

  const cacheKey = generateCacheKey(
    character.id,
    character.face_preset_id,
    character.hair_preset_id,
    character.outfit_preset_id,
    actionTag,
    moodTag
  );

  // เช็ค cache ก่อน ถ้ามีแล้วไม่ต้องเข้าคิว
  const cached = await checkImageCache(cacheKey);
  if (cached) return { status: 'cached', url: cached };

  // ใส่เข้าคิว (upsert เพื่อกัน duplicate)
  const { data, error } = await supabase.from('image_queue').upsert({
    char_id:  character.id,
    cache_key: cacheKey,
    prompt,
    negative: negativePrompt,
    status:   'pending',
    priority: character.is_shadow_heir ? 2 : 5  // Shadow Heir ได้ priority พิเศษ
  }, { onConflict: 'cache_key' }).select().single();

  if (error) throw error;
  return { status: 'queued', queueId: data.id };
}


// ============================================================
// SECTION 4 : QUEUE WORKER  (Edge Function ใน Supabase)
// ============================================================
//
// Deploy ใน Supabase → Edge Functions → "process-image-queue"
// ตั้ง CRON ให้รันทุก 3 วินาที หรือ trigger จาก Realtime
//
// RATE LIMIT STRATEGY:
//   Free SD API: ~3-5 requests/minute
//   → Worker ดึง 3 งานต่อรอบ
//   → ถ้า API ล่ม → retry สูงสุด 3 ครั้ง
//

const SD_API_ENDPOINT = process.env.SD_API_URL;  // e.g. RunDiffusion / Replicate
const MAX_CONCURRENT  = 3;
const MAX_RETRIES     = 3;

async function processImageQueue() {
  // ดึงงาน pending ที่ยังไม่ถูกประมวลผล
  const { data: jobs } = await supabase
    .from('image_queue')
    .select('*')
    .eq('status', 'pending')
    .lt('attempts', MAX_RETRIES)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(MAX_CONCURRENT);

  if (!jobs || jobs.length === 0) return;

  // Mark as processing (กัน race condition)
  const jobIds = jobs.map(j => j.id);
  await supabase.from('image_queue')
    .update({ status: 'processing', attempts: supabase.raw('attempts + 1') })
    .in('id', jobIds);

  // ประมวลผลแบบ parallel
  await Promise.allSettled(jobs.map(async (job) => {
    try {
      // เรียก Stable Diffusion API
      const imageBlob = await callStableDiffusion(job.prompt, job.negative);

      // บันทึกรูปลง Storage
      const url = await saveImageToCache(job.cache_key, imageBlob);

      // อัป status = done + เก็บ URL
      await supabase.from('image_queue').update({
        status:       'done',
        result_url:   url,
        processed_at: new Date().toISOString()
      }).eq('id', job.id);

      // แจ้ง character ว่ารูปพร้อมแล้ว (Realtime)
      await supabase.from('notifications').insert({
        type:         'system',
        recipient_id:  (await supabase.from('characters').select('user_id').eq('id', job.char_id).single()).data.user_id,
        content:      '🖼️ รูปตัวละครของคุณพร้อมแล้ว!',
        metadata:     { image_url: url, queue_id: job.id }
      });

    } catch (err) {
      // Mark failed ถ้า retry หมดแล้ว
      const newStatus = job.attempts >= MAX_RETRIES - 1 ? 'failed' : 'pending';
      await supabase.from('image_queue').update({
        status:    newStatus,
        error_msg: err.message
      }).eq('id', job.id);
    }
  }));
}

async function callStableDiffusion(prompt, negativePrompt) {
  const response = await fetch(SD_API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SD_API_KEY}` },
    body: JSON.stringify({
      prompt,
      negative_prompt: negativePrompt,
      width:  512,
      height: 768,   // Portrait ratio สำหรับ Webtoon
      steps:  25,
      cfg_scale: 7.5,
      sampler: "DPM++ 2M Karras"
    })
  });
  // คืนเป็น Blob (WebP preferred)
  return await response.blob();
}


// ============================================================
// SECTION 5 : LOADING UI  (ไม่ให้ผู้เล่นรู้สึกเบื่อระหว่างรอ)
// ============================================================
//
// STRATEGY: แบ่ง loading เป็น 3 stage
//   Stage 1 (0-2s)   : แสดง "System Narrator" บอกเหตุการณ์
//   Stage 2 (2-6s)   : Progress bar + flavor text เปลี่ยนทุก 1.5s
//   Stage 3 (6-10s)  : "Finalizing..." + dramatic reveal effect
//

const NARRATOR_LINES = {
  fighting: [
    "[ System: A Gate of unknown rank has appeared before the hunter... ]",
    "[ System: Detecting extraordinary mana concentration... ]",
    "[ System: Initiating combat record sequence... ]",
    "[ System: The hunter's shadow stirs... ]"
  ],
  levelup: [
    "[ System: An incredible surge of power is detected. ]",
    "[ System: Rank recalculation in progress... ]",
    "[ System: The hunter has surpassed their previous limits. ]"
  ],
  travel: [
    "[ System: Scanning new territory... ]",
    "[ System: Gate signatures detected in this region. ]",
    "[ System: Registering hunter location... ]"
  ],
  default: [
    "[ System: Processing hunter data... ]",
    "[ System: Loading mission parameters... ]",
    "[ System: Standby... ]"
  ]
};

/**
 * WebtoonLoadingScreen — React Component
 * แสดงระหว่างรอ AI สร้างรูป
 */
function WebtoonLoadingScreen({ actionTag = 'default', onComplete }) {
  const [stage, setStage] = React.useState(1);
  const [progress, setProgress] = React.useState(0);
  const [narratorIdx, setNarratorIdx] = React.useState(0);
  const lines = NARRATOR_LINES[actionTag] || NARRATOR_LINES.default;

  React.useEffect(() => {
    // Progress animation
    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 100) { clearInterval(interval); return 100; }
        // เร็วช่วงต้น ช้าช่วงท้าย (natural feel)
        const delta = prev < 70 ? 2.5 : prev < 90 ? 0.8 : 0.3;
        return Math.min(prev + delta, 99);  // หยุดที่ 99 รอ server confirm
      });
    }, 150);

    // Narrator text rotation ทุก 1.5 วินาที
    const narratorInterval = setInterval(() => {
      setNarratorIdx(i => (i + 1) % lines.length);
    }, 1500);

    // Stage transitions
    setTimeout(() => setStage(2), 2000);
    setTimeout(() => setStage(3), 6000);

    return () => { clearInterval(interval); clearInterval(narratorInterval); };
  }, []);

  return {
    stage,
    progress,
    narratorLine: lines[narratorIdx],
    // CSS classes: "webtoon-loading-overlay fade-in" etc.
  };
}

/**
 * pollForResult()
 * Subscribe Realtime เพื่อรับ URL รูปที่เจนเสร็จ
 * ไม่ต้อง polling ตลอด — ประหยัด bandwidth
 */
function pollForResult(queueId, onDone) {
  const channel = supabase
    .channel(`queue-${queueId}`)
    .on('postgres_changes', {
      event:  'UPDATE',
      schema: 'public',
      table:  'image_queue',
      filter: `id=eq.${queueId}`
    }, (payload) => {
      if (payload.new.status === 'done') {
        onDone(payload.new.result_url);
        // Reveal animation
        setTimeout(() => triggerDramaticReveal(payload.new.result_url), 200);
        channel.unsubscribe();
      }
    })
    .subscribe();

  return channel;
}

/**
 * triggerDramaticReveal()
 * ตอนที่รูปโหลดเสร็จ → animate reveal เหมือนในเรื่อง Solo Leveling
 */
function triggerDramaticReveal(imageUrl) {
  // CSS class sequence:
  //   1. overlay flash (white)
  //   2. image appears from center
  //   3. neon border flicker
  //   4. "[ System: Image data confirmed. ]" notification
  console.log(`REVEAL: ${imageUrl}`);
  // Implementation: เพิ่ม CSS class "dramatic-reveal" กับ container
}


// ============================================================
// SECTION 6 : PARTY GROUP IMAGE  (เห็นทั้งตี้ในรูปเดียว)
// ============================================================
//
// เมื่อตี้ลงดันเจี้ยนพร้อมกัน → สร้างรูปกลุ่ม 1 รูป
// ประหยัด API quota: 1 call แทน 5 calls
//

async function buildPartyGroupPrompt(partyMembers) {
  // ดึง preset ของแต่ละสมาชิก
  const memberDescriptions = await Promise.all(
    partyMembers.slice(0, 5).map(async (char, index) => {
      const { data: face }  = await supabase.from('face_presets').select('ai_prompt').eq('id', char.face_preset_id).single();
      const { data: cls }   = await supabase.from('classes').select('name').eq('id', char.class_id).single();
      return `character ${index + 1}: ${cls.name}, ${face.ai_prompt.split(',').slice(0, 3).join(',')}`;
    })
  );

  return [
    BASE_STYLE_ANCHOR,
    `group of ${partyMembers.length} hunters`,
    memberDescriptions.join("; "),
    "dynamic group battle pose",
    "entering dungeon gate",
    "dramatic team composition shot",
    "each character distinct and recognizable"
  ].join(", ");
}


// ============================================================
// SECTION 7 : MASTER FLOW SUMMARY
// ============================================================
//
//  Player Action
//       │
//       ▼
//  buildCharacterPrompt()  ←── Face/Hair/Outfit preset from DB
//       │
//       ▼
//  generateCacheKey()
//       │
//       ├─── Cache HIT ──→  Return URL immediately  (0ms)
//       │
//       └─── Cache MISS ──→  enqueueImageRequest()
//                                    │
//                                    ▼
//                             image_queue table
//                                    │
//                                    ▼
//                           WebtoonLoadingScreen()  ←── Player sees narrator text
//                                    │
//                                    ▼
//                           Edge Function Worker (every 3s)
//                                    │
//                                    ├── callStableDiffusion()  ←── SD API
//                                    │
//                                    └── saveImageToCache()  ──→  Supabase Storage
//                                                │
//                                                ▼
//                                       Realtime notification
//                                                │
//                                                ▼
//                                       triggerDramaticReveal()
//
// ============================================================
// COST ANALYSIS (Free Tier Estimate)
// ============================================================
//
//  Supabase Free:     500MB DB, 1GB Storage, 50MB Edge Functions
//  Replicate Free:    ~100 images/month free trial
//  RunDiffusion:      Pay per image (~$0.006/image)
//
//  With caching:
//    ถ้า 1,000 users แต่ action หลักมี 20 แบบ
//    → จริงๆ เรียก API แค่ 20 × 45 faces × 50 hairs = ต่างกันมาก
//    → ใน practice: cache hit rate ~60-70% หลังสัปดาห์แรก
//    → ประมาณ 500-800 unique images/วัน ≈ $3-5/วัน
//
// ============================================================
// SUPABASE TABLES TO ADD (นอกจาก neon_destiny_complete.sql)
// ============================================================
//
//  CREATE TABLE image_queue (
//    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
//    char_id       UUID NOT NULL REFERENCES characters(id),
//    cache_key     VARCHAR(64) NOT NULL UNIQUE,
//    prompt        TEXT NOT NULL,
//    negative      TEXT,
//    status        VARCHAR(20) DEFAULT 'pending',
//    priority      INT DEFAULT 5,
//    result_url    TEXT,
//    error_msg     TEXT,
//    attempts      INT DEFAULT 0,
//    created_at    TIMESTAMPTZ DEFAULT NOW(),
//    processed_at  TIMESTAMPTZ
//  );
//
//  ALTER PUBLICATION supabase_realtime ADD TABLE image_queue;
//
//  Supabase Storage Buckets:
//    - "webtoon-cache"  (public, no size limit per file, 30-day cache headers)
//    - "party-images"   (public)
//
// ============================================================
