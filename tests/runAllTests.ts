import { spawnSync } from 'child_process';
import path from 'path';

const testFiles = [
  'tests/brainSignalUnificationRegression.test.ts',
  'tests/mt5BridgeAndDemoTradingRegression.test.ts',
  'tests/comprehensiveRepairsRegression.test.ts',
  'tests/opportunityDetectionAuditRegression.test.ts',
  'tests/tpSelectionRegression.test.ts',
  'server/entryLocationQualityRegressionTests.ts',
  'server/priceActionHardeningTests.ts',
  'server/trendContinuationQualityGateTests.ts',
  'tests/providerApiRouting.test.ts',
  'tests/aiConfidenceValidation.test.ts',
  'tests/s9SqueezeGateRegression.test.ts',
  'tests/poiPersistence.test.ts',
  'tests/strategyQualityPhase2To14Regression.test.ts',
  'tests/analyticalBugFixesRegression.test.ts',
  'tests/indicatorMathQualityRegression.test.ts',
  'tests/confidenceCalibrationAndPartitioning.test.ts',
  'tests/s12S10S8PrecisionRegression.test.ts',
  'tests/adminAndRouteSecurity.test.ts',
  'tests/backtestCircularSerializationRegression.test.ts',
  'tests/manualScanTriggerRegression.test.ts',
  'tests/mt5BridgeCandlePersistence.test.ts',
  'tests/phase1LiveExecutionSafetyRegression.test.ts',
];

console.log('====================================================');
console.log('RUNNING FULL AUTOMATED REGRESSION TEST SUITE');
console.log('====================================================\n');

let failedCount = 0;
let passedCount = 0;

for (const file of testFiles) {
  console.log(`\n----------------------------------------------------`);
  console.log(`Executing: ${file}`);
  console.log(`----------------------------------------------------`);

  const result = spawnSync('npx', ['tsx', file], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });

  if (result.status === 0) {
    passedCount++;
    console.log(`✔ [PASS] ${file}`);
  } else {
    failedCount++;
    console.error(`✖ [FAIL] ${file} (Exit code: ${result.status})`);
  }
}

console.log('\n====================================================');
console.log(`TEST SUITE RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('====================================================');

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
