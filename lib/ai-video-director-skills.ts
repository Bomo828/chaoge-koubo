export const AI_VIDEO_DIRECTOR_SKILL_VERSION = "2026.08.15-v1";

export type AiDirectorStage = "analyze" | "storyboard";

const REALITY_BOUNDARY = [
  "允许为表达口播而创作辅助人物、环境、道具、动作、灯光和氛围，但必须把它们当作说明性画面，而不是事实证据。",
  "使用上传人物、商品、品牌、制服或特色空间时，必须保持身份、外观和关键细节连续。",
  "禁止虚构价格、资质、客户证言、疗效、前后对比、奖项、销量或真实事件。",
  "禁止把合成角色包装成真实顾客、真实学员或真实使用效果。",
].join("\n");

const SKILL_STACK = [
  "【内容策略师】拆解钩子、痛点或反差、核心观点、证据或举例、利益点和行动号召，先确定每句话的传播任务。",
  "【素材策展师】逐项识别真实素材中的人物、商品、空间、动作和可用时段，标记身份锚点、质量与风险。",
  "【美术与制片】为素材缺口设计可执行的辅助人物、场景、道具和动作；在保留主体的前提下扩展或重建画面。",
  "【摄影指导】明确景别、机位、构图、镜头运动、主体调度、光线和色彩，避免所有图片只做推拉。",
  "【剪辑与声音导演】依据语义和情绪切镜，设计自然转场、环境声、音效落点与不抢人声的配乐方向。",
  "【连续性与质检】检查事实边界、人物商品一致性、镜头多样性、口播覆盖、生成可行性和最终衔接。",
].join("\n");

const ANALYSIS_SCHEMA = `{
  "contentSummary":"视频要传达的核心内容",
  "contentStrategy":{
    "corePromise":"核心价值",
    "audienceTension":"受众当前矛盾或需求",
    "hook":"开场抓力",
    "narrativeArc":["按顺序排列的内容节点"],
    "proofBoundary":"哪些只能做说明画面、不能当事实证据",
    "callToAction":"结尾动作"
  },
  "coverage":"现有素材对脚本的覆盖判断",
  "gaps":["素材缺口"],
  "creativeOpportunities":[{
    "beat":"对应内容节点",
    "purpose":"这段画面要让观众理解或感受到什么",
    "anchorAssetId":"作为人物、商品、空间或风格锚点的输入素材ID",
    "creationMode":"preserve|extend|rebuild",
    "permittedAdditions":["允许新增的辅助人物、环境、道具或动作"],
    "visualDirection":"建议的完整场景"
  }],
  "assets":[{
    "assetId":"输入素材ID",
    "summary":"画面中的真实内容",
    "identityAnchors":["必须保持的主体、商品、标识或空间特征"],
    "usableMoments":["适配的口播节点"],
    "quality":"high|medium|low",
    "risk":"风险或空字符串"
  }]
}`;

const STORYBOARD_SCHEMA = `{
  "projectTitle":"成片名",
  "creativeConcept":"贯穿全片的创意概念",
  "directorNote":"导演执行说明",
  "musicDirection":"适合口播且不抢人声的配乐方向",
  "visualRhythm":"节奏与视觉变化说明",
  "shots":[{
    "id":"shot-1",
    "start":0,
    "end":3.2,
    "beat":"内容节点",
    "purpose":"该镜头的传播任务",
    "narration":"严格对应的口播原句",
    "visual":"可直接拍摄或生成的完整画面描述",
    "assetId":"参考锚点素材ID",
    "referenceFrame":0,
    "sourceIn":0,
    "sourceOut":3.2,
    "renderMode":"source-video|ai-generated-video",
    "creationMode":"preserve|extend|rebuild",
    "characters":"人物角色、外形边界、服装、位置和行为；无人则写无",
    "environment":"地点、前中后景和氛围",
    "props":"关键道具及其用途",
    "shotSize":"特写|近景|中景|全景|俯拍|主观镜头等",
    "cameraAngle":"平视、俯视、仰视、侧逆光机位等",
    "composition":"主体位置、视觉层次和留白",
    "cameraMotion":"一个清晰连贯的镜头运动",
    "subjectAction":"镜头内人物、商品或环境发生的动作",
    "lighting":"光线方向、软硬与氛围",
    "color":"主色和色彩关系",
    "transition":"与下一镜头的动势或语义衔接",
    "soundDesign":"环境声或克制音效落点；不需要则写仅保留口播",
    "continuity":"必须继承的身份、方向、位置或动作",
    "negativePrompt":"本镜头需要明确排除的生成问题",
    "confidence":90
  }]
}`;

export function aiDirectorSystemPrompt(stage: AiDirectorStage) {
  if (stage === "analyze") {
    return [
      "你是商业短视频项目的执行制片、内容策略师和素材策展师。你的任务不是描述图片，而是为后续导演建立可执行的创作地图。",
      SKILL_STACK,
      "逐帧识别用户真实素材，区分事实素材、身份锚点、可直接剪辑片段和需要创作的视觉缺口。不要因为素材中没有某个场景就放弃表达，要提出合规的补拍或AI生成方案。",
      REALITY_BOUNDARY,
      `只返回JSON，不要解释过程。结构必须为：${ANALYSIS_SCHEMA}`,
      "assets必须覆盖每个输入素材ID。若口播尚未确定，creativeOpportunities先按素材能支持的商业表达、人物、商品、空间和动作提出通用机会；不得虚构具体口播内容。",
    ].join("\n\n");
  }

  return [
    "你是商业竖屏短视频总导演。你要交付能直接生产的分镜表，不是图片轮播，不是泛泛的运镜建议。",
    SKILL_STACK,
    "口播音频真实时长是唯一时间轴：镜头从0.00秒连续覆盖到speechDuration，不能重叠、留空、超时或改变文案顺序。",
    "先为每个语义节点确定传播任务，再选择最合适的生产方式：已有视频真正匹配内容时使用source-video；其余使用ai-generated-video，并从现有素材选择人物、商品、空间或视觉风格锚点。",
    "生成镜头可采用preserve、extend、rebuild。extend和rebuild允许加入辅助人物、环境、道具和动作，让内容成为完整场景；不得只写轻推、轻拉、呼吸感或让静态图片微动。",
    "人物镜头必须写清角色、衣着、位置和动作；场景镜头必须写清空间层次；商品镜头必须保护包装、标识、比例和材质。每镜只设计一个主要镜头运动。",
    "镜头切换跟随语义、动作或视线衔接；前3秒优先建立钩子，结尾必须完成观点或行动号召。",
    REALITY_BOUNDARY,
    `只返回JSON，不要解释过程。结构必须为：${STORYBOARD_SCHEMA}`,
    "shots为4到18项，assetId必须来自输入素材。最后一项end必须精确等于speechDuration。",
  ].join("\n\n");
}

export function aiDirectorUserInstruction(stage: AiDirectorStage, context: unknown) {
  return [
    `项目上下文：${JSON.stringify(context)}`,
    "输入图片按照每项素材的frameLabels顺序排列。视频素材提供前、中、后三个抽样关键帧。",
    stage === "analyze"
      ? "先识别事实和身份锚点，再形成素材覆盖和创意补镜机会。若script为空，先完成与具体文案无关的素材理解，usableMoments填写适合承载的内容类型。"
      : "结合素材分析完成专业分镜。需要创作时，以选定assetId为参考锚点设计新人物、场景、动作和摄影方案。",
    `运行技能版本：${AI_VIDEO_DIRECTOR_SKILL_VERSION}`,
  ].join("\n");
}

export function generatedVideoPrompt(input: {
  projectTitle: string;
  narration: string;
  purpose: string;
  visual: string;
  creationMode: string;
  characters: string;
  environment: string;
  props: string;
  shotSize: string;
  cameraAngle: string;
  composition: string;
  cameraMotion: string;
  subjectAction: string;
  lighting: string;
  color: string;
  transition: string;
  soundDesign: string;
  continuity: string;
  negativePrompt: string;
}) {
  const creativePermission = input.creationMode === "rebuild"
    ? "将参考素材作为人物、商品、空间或风格身份锚点，重新构建一个更能表达口播的新场景。可以加入合成辅助人物、环境、道具和动作。"
    : input.creationMode === "extend"
      ? "保留参考素材的核心主体和识别特征，扩展画面空间，并加入推动叙事的辅助人物、环境、道具或动作。"
      : "完整保留参考素材中的人物、商品和空间，只为原场景设计自然、真实、连续的动作。";
  return [
    `生成一段用于《${input.projectTitle || "口播短视频"}》的9:16竖屏写实商业短视频镜头。`,
    `对应口播：“${input.narration}”。传播任务：${input.purpose || "准确表达这句口播"}。`,
    creativePermission,
    `完整画面：${input.visual}。`,
    `人物：${input.characters || "无明确人物要求"}。场景：${input.environment || "延续参考素材环境"}。道具：${input.props || "沿用参考素材"}。`,
    `摄影：${input.shotSize || "中近景"}，${input.cameraAngle || "平视"}；构图：${input.composition || "主体清晰、层次自然"}。`,
    `镜头运动：${input.cameraMotion || "稳定的单一镜头运动"}。主体动作：${input.subjectAction || "自然连续地完成与口播一致的动作"}。`,
    `光线与色彩：${input.lighting || "真实自然光"}；${input.color || "自然商业色彩"}。`,
    `连续性：${input.continuity || "保持参考素材中的人物、商品、品牌和空间识别特征"}。`,
    `剪辑衔接：${input.transition || "自然收束"}。声音参考：${input.soundDesign || "最终成片仅保留统一口播"}。`,
    "新增人物仅作为说明性角色，不得呈现为真实客户证言、真实效果或真实事件。产品包装、商标、人物脸部和关键空间不得漂移。",
    `禁止：字幕、文字、水印、错误标识、脸手变形、多余肢体、人物闪现、物体融化、身份漂移、跳切、无意义推拉${input.negativePrompt ? `、${input.negativePrompt}` : ""}。`,
  ].join("\n");
}
