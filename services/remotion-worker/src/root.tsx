import React from "react";
import {Composition} from "remotion";
import {MerchantViralVertical} from "./vertical-video";
import type {ViralTimeline} from "./types";

const defaultTimeline: ViralTimeline = {
  version: 1,
  sourceFile: "source.mp4",
  duration: 15,
  fps: 30,
  title: "真实内容 值得看见",
  captions: [],
  chapters: [],
  cards: [],
  theme: {
    name: "轻奢白·双语",
    background: "#09130f",
    foreground: "#ffffff",
    accent: "#f2cf63",
    accentSoft: "rgba(242,207,99,.2)",
    titlePosition: "top",
    subtitlePosition: "middle",
  },
};

export const Root: React.FC = () => (
  <Composition
    id="MerchantViralVertical"
    component={MerchantViralVertical}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={450}
    defaultProps={{timeline: defaultTimeline}}
  />
);
