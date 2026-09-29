pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

// V2 proves comparisons for up to twelve campaign conditions. The issuer
// supplies the private, account-bound facts; the policy hash commits to each
// condition's type, operator, threshold and target. A proof does not establish
// that Copus measured a real-world event correctly: that is the issuer trust
// boundary, just as for the original reading receipt.
template ProofOfExperienceV2(depth, slots) {
    signal input evidenceRoot;
    signal input ruleHash;
    signal input nullifier;
    signal input campaignId;
    signal input epoch;

    signal input subjectSecret;
    signal input eventCount;
    signal input totalDwellSeconds;
    signal input observedAt;
    signal input receiptNonce;
    signal input facts[slots];

    signal input minEvents;
    signal input minDwellSeconds;
    signal input notBefore;
    signal input matchMode; // 0 = all, 1 = any; an empty list passes either mode
    signal input ruleTypes[slots]; // zero denotes an unused slot
    signal input ruleOperators[slots]; // 1 >=, 2 <=, 3 ==
    signal input ruleThresholds[slots];
    signal input ruleTargets[slots]; // field commitment to a target, zero if none
    signal input pathElements[depth];
    signal input pathIndices[depth];

    matchMode * (matchMode - 1) === 0;

    component baseLeaf = Poseidon(5);
    baseLeaf.inputs[0] <== subjectSecret;
    baseLeaf.inputs[1] <== eventCount;
    baseLeaf.inputs[2] <== totalDwellSeconds;
    baseLeaf.inputs[3] <== observedAt;
    baseLeaf.inputs[4] <== receiptNonce;

    component readingPolicy = Poseidon(3);
    readingPolicy.inputs[0] <== minEvents;
    readingPolicy.inputs[1] <== minDwellSeconds;
    readingPolicy.inputs[2] <== notBefore;

    component readingCountBits = Num2Bits(64);
    readingCountBits.in <== eventCount;
    component readingSecondsBits = Num2Bits(64);
    readingSecondsBits.in <== totalDwellSeconds;
    component observedBits = Num2Bits(64);
    observedBits.in <== observedAt;
    component minCountBits = Num2Bits(64);
    minCountBits.in <== minEvents;
    component minSecondsBits = Num2Bits(64);
    minSecondsBits.in <== minDwellSeconds;
    component notBeforeBits = Num2Bits(64);
    notBeforeBits.in <== notBefore;

    component enoughEvents = GreaterEqThan(64);
    enoughEvents.in[0] <== eventCount;
    enoughEvents.in[1] <== minEvents;
    enoughEvents.out === 1;
    component enoughDwell = GreaterEqThan(64);
    enoughDwell.in[0] <== totalDwellSeconds;
    enoughDwell.in[1] <== minDwellSeconds;
    enoughDwell.out === 1;
    component recentEnough = GreaterEqThan(64);
    recentEnough.in[0] <== observedAt;
    recentEnough.in[1] <== notBefore;
    recentEnough.out === 1;

    signal factHash[slots + 1];
    signal ruleHashChain[slots + 1];
    signal activeCount[slots + 1];
    signal passCount[slots + 1];
    signal failCount[slots + 1];
    factHash[0] <== 0;
    ruleHashChain[0] <== 0;
    activeCount[0] <== 0;
    passCount[0] <== 0;
    failCount[0] <== 0;

    component factHashers[slots];
    component ruleItems[slots];
    component ruleHashers[slots];
    component unused[slots];
    component opGe[slots];
    component opLe[slots];
    component opEq[slots];
    component factBits[slots];
    component thresholdBits[slots];
    component ge[slots];
    component le[slots];
    component eq[slots];
    signal active[slots];
    signal satisfied[slots];
    signal gePass[slots];
    signal lePass[slots];
    signal eqPass[slots];

    for (var i = 0; i < slots; i++) {
        factBits[i] = Num2Bits(64);
        factBits[i].in <== facts[i];
        thresholdBits[i] = Num2Bits(64);
        thresholdBits[i].in <== ruleThresholds[i];

        unused[i] = IsZero();
        unused[i].in <== ruleTypes[i];
        active[i] <== 1 - unused[i].out;
        opGe[i] = IsEqual();
        opGe[i].in[0] <== ruleOperators[i];
        opGe[i].in[1] <== 1;
        opLe[i] = IsEqual();
        opLe[i].in[0] <== ruleOperators[i];
        opLe[i].in[1] <== 2;
        opEq[i] = IsEqual();
        opEq[i].in[0] <== ruleOperators[i];
        opEq[i].in[1] <== 3;
        opGe[i].out + opLe[i].out + opEq[i].out === active[i];
        unused[i].out * facts[i] === 0;
        unused[i].out * ruleThresholds[i] === 0;
        unused[i].out * ruleTargets[i] === 0;

        ge[i] = GreaterEqThan(64);
        ge[i].in[0] <== facts[i];
        ge[i].in[1] <== ruleThresholds[i];
        le[i] = GreaterEqThan(64);
        le[i].in[0] <== ruleThresholds[i];
        le[i].in[1] <== facts[i];
        eq[i] = IsEqual();
        eq[i].in[0] <== facts[i];
        eq[i].in[1] <== ruleThresholds[i];
        gePass[i] <== opGe[i].out * ge[i].out;
        lePass[i] <== opLe[i].out * le[i].out;
        eqPass[i] <== opEq[i].out * eq[i].out;
        satisfied[i] <== gePass[i] + lePass[i] + eqPass[i];
        activeCount[i + 1] <== activeCount[i] + active[i];
        passCount[i + 1] <== passCount[i] + satisfied[i];
        failCount[i + 1] <== failCount[i] + active[i] - satisfied[i];

        factHashers[i] = Poseidon(2);
        factHashers[i].inputs[0] <== factHash[i];
        factHashers[i].inputs[1] <== facts[i];
        factHash[i + 1] <== factHashers[i].out;

        ruleItems[i] = Poseidon(4);
        ruleItems[i].inputs[0] <== ruleTypes[i];
        ruleItems[i].inputs[1] <== ruleOperators[i];
        ruleItems[i].inputs[2] <== ruleThresholds[i];
        ruleItems[i].inputs[3] <== ruleTargets[i];
        ruleHashers[i] = Poseidon(2);
        ruleHashers[i].inputs[0] <== ruleHashChain[i];
        ruleHashers[i].inputs[1] <== ruleItems[i].out;
        ruleHashChain[i + 1] <== ruleHashers[i].out;
    }

    // ALL: no failed active slots. ANY: one passed slot if any are active.
    (1 - matchMode) * failCount[slots] === 0;
    component noPass = IsZero();
    noPass.in <== passCount[slots];
    component noRules = IsZero();
    noRules.in <== activeCount[slots];
    signal anyRequired;
    anyRequired <== matchMode * (1 - noRules.out);
    anyRequired * noPass.out === 0;

    component campaignPolicy = Poseidon(3);
    campaignPolicy.inputs[0] <== readingPolicy.out;
    campaignPolicy.inputs[1] <== matchMode;
    campaignPolicy.inputs[2] <== ruleHashChain[slots];
    campaignPolicy.out === ruleHash;

    component leaf = Poseidon(2);
    leaf.inputs[0] <== baseLeaf.out;
    leaf.inputs[1] <== factHash[slots];
    signal level[depth + 1];
    level[0] <== leaf.out;
    component nodes[depth];
    signal left[depth];
    signal right[depth];
    for (var j = 0; j < depth; j++) {
        pathIndices[j] * (pathIndices[j] - 1) === 0;
        left[j] <== level[j] + pathIndices[j] * (pathElements[j] - level[j]);
        right[j] <== pathElements[j] + pathIndices[j] * (level[j] - pathElements[j]);
        nodes[j] = Poseidon(2);
        nodes[j].inputs[0] <== left[j];
        nodes[j].inputs[1] <== right[j];
        level[j + 1] <== nodes[j].out;
    }
    level[depth] === evidenceRoot;

    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== subjectSecret;
    nullifierHasher.inputs[1] <== campaignId;
    nullifierHasher.inputs[2] <== epoch;
    nullifierHasher.out === nullifier;
}

component main { public [evidenceRoot, ruleHash, nullifier, campaignId, epoch] } = ProofOfExperienceV2(8, 12);
