import { resolveAiProviderConfig } from '../server/geminiTrader.js';

function runTests() {
  console.log('====================================================');
  console.log('RUNNING PROVIDER API ROUTING REGRESSION TESTS');
  console.log('====================================================\n');

  const oldEnv = { ...process.env };

  try {
    // Test 1: Custom runtime provider configuration
    process.env.AI_PROVIDER = 'custom_llm';
    process.env.AI_API_KEY = 'sk-custom-1234567890';
    process.env.AI_BASE_URL = 'https://ai-proxy.example.com/v1';
    process.env.AI_MODEL = 'custom-model-v2';
    delete process.env.NVIDIA_API_KEY;

    let config = resolveAiProviderConfig();
    if (config.provider !== 'custom_llm' || config.baseURL !== 'https://ai-proxy.example.com/v1' || config.model !== 'custom-model-v2') {
      throw new Error(`Test 1 Failed: expected custom_llm config, got ${JSON.stringify(config)}`);
    }
    console.log('✔ PASS: Test 1: Generic/custom AI provider properly configured');

    // Test 2: NVIDIA provider with valid key
    delete process.env.AI_API_KEY;
    process.env.AI_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'nvapi-abcdef1234567890';
    process.env.NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
    process.env.NVIDIA_MODEL = 'deepseek-ai/deepseek-v4-flash-0731';

    config = resolveAiProviderConfig();
    if (config.provider !== 'nvidia' || config.baseURL !== 'https://integrate.api.nvidia.com/v1' || config.model !== 'deepseek-ai/deepseek-v4-flash-0731') {
      throw new Error(`Test 2 Failed: expected nvidia config, got ${JSON.stringify(config)}`);
    }
    console.log('✔ PASS: Test 2: NVIDIA provider properly configured');

    // Test 3: Unconfigured environment safety fallback
    delete process.env.AI_PROVIDER;
    delete process.env.AI_API_KEY;
    delete process.env.NVIDIA_API_KEY;

    config = resolveAiProviderConfig();
    if (config.provider !== 'none' || config.apiKey !== '') {
      throw new Error(`Test 3 Failed: expected none provider, got ${JSON.stringify(config)}`);
    }
    console.log('✔ PASS: Test 3: Unconfigured environment correctly resolves to provider: none');

    console.log('\n====================================================');
    console.log('ALL PROVIDER API ROUTING TESTS PASSED (3/3)');
    console.log('====================================================\n');
  } finally {
    process.env = oldEnv;
  }
}

runTests();
