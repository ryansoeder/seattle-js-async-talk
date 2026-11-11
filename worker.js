// ⚡ FIX — Segment 5: matching runs here, on the worker's own thread. A worker can't touch
// the DOM, so it only computes and posts results back; the page does the rendering.
importScripts('matcher.js');

const PROGRESS_EVERY_MS = 16; // about once per frame

let allTrials = []; // sent once per search, kept for every match after that

onmessage = ({ data: message }) => {
  if (message.allTrials) {
    allTrials = message.allTrials;
    return;
  }
  const matchScores = [];
  let lastProgressPost = performance.now();
  for (let i = 0; i < allTrials.length; i++) {
    matchScores[i] = scoreTrial(allTrials[i], message.patientProfile);
    if (performance.now() - lastProgressPost > PROGRESS_EVERY_MS) {
      postMessage({ progress: i / allTrials.length }); // so the bar moves smoothly
      lastProgressPost = performance.now();
    }
  }
  postMessage({ matchScores });
};
