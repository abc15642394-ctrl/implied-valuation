document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('calculateBtn').addEventListener('click', calculate);
  
  // 添加輸入監聽器
  const inputs = ['stockPrice', 'eps', 'cagr1_5', 'cagr6_10'].forEach(id => {
    document.getElementById(id).addEventListener('input', checkAllFieldsFilled);
  });

  // 新增複合成長率計算機的事件監聽器
  document.getElementById('calculateCAGRBtn').addEventListener('click', calculateCompoundGrowth);
  
  // 監聽年數變化，動態調整輸入框的啟用/禁用狀態
  document.getElementById('yearCount').addEventListener('input', function() {
    updateGrowthInputs(this.value);
  });

  // 新增期初期末計算機的事件監聽器
  document.getElementById('calculateStartEndBtn').addEventListener('click', calculateStartEndCAGR);
});

// 新增檢查所有欄位是否填寫的函數
function checkAllFieldsFilled() {
  const stockPrice = document.getElementById('stockPrice').value;
  const eps = document.getElementById('eps').value;
  const cagr1_5 = document.getElementById('cagr1_5').value;
  const cagr6_10 = document.getElementById('cagr6_10').value;

  if (stockPrice && eps && cagr1_5 && cagr6_10) {
    document.getElementById('result').textContent = '大哥!!! 你全部都key完了，我是要算什麼?';
    return;
  }
}

function calculate() {
  const stockPrice = parseFloat(document.getElementById('stockPrice').value);
  const eps = parseFloat(document.getElementById('eps').value);
  const cagr1_5 = parseFloat(document.getElementById('cagr1_5').value) / 100;
  const cagr6_10 = parseFloat(document.getElementById('cagr6_10').value) / 100;
  const discountRate = 0.10;  // 固定 10%
  const perpetualGrowthRate = 0.02;  // 固定 2%

  // 檢查輸入組合
  if (stockPrice && eps && cagr1_5 && cagr6_10) {
    document.getElementById('result').textContent = '請留空股價或1-5年CAGR其中之一';
    return;
  }

  if (stockPrice && eps && cagr6_10) {
    // 計算1-5年CAGR
    calculateCAGR1_5(stockPrice, eps, cagr6_10, discountRate, perpetualGrowthRate);
  } else if (eps && cagr1_5 && cagr6_10) {
    // 計算股價
    calculateStockPrice(eps, cagr1_5, cagr6_10, discountRate, perpetualGrowthRate);
  } else {
    document.getElementById('result').textContent = '請填寫必要欄位';
  }
}

function calculateStockPrice(eps, cagr1_5, cagr6_10, discountRate, perpetualGrowthRate) {
  let presentValue = 0;
  let currentEPS = eps;

  // 計算1-5年的現值
  for (let i = 1; i <= 5; i++) {
    currentEPS *= (1 + cagr1_5);
    presentValue += currentEPS / Math.pow(1 + discountRate, i);
  }

  // 計算6-10年的現值
  for (let i = 6; i <= 10; i++) {
    currentEPS *= (1 + cagr6_10);
    presentValue += currentEPS / Math.pow(1 + discountRate, i);
  }

  // 計算永續價值
  const terminalValue = (currentEPS * (1 + perpetualGrowthRate)) / 
                       (discountRate - perpetualGrowthRate);
  const presentTerminalValue = terminalValue / Math.pow(1 + discountRate, 10);

  const fairValue = presentValue + presentTerminalValue;
  
  document.getElementById('result').textContent = 
    `計算結果：預估股價為 ${fairValue.toFixed(2)} 元`;
}

function calculateCAGR1_5(stockPrice, eps, cagr6_10, discountRate, perpetualGrowthRate) {
  // 使用二分搜尋法找出符合目標股價的1-5年CAGR
  let left = -0.5;  // -50%
  let right = 2.0;  // 200%
  let iterations = 0;
  const maxIterations = 50;
  
  while (iterations < maxIterations) {
    const mid = (left + right) / 2;
    const calculatedPrice = calculatePriceWithCAGR(eps, mid, cagr6_10, 
                                                 discountRate, perpetualGrowthRate);
    
    if (Math.abs(calculatedPrice - stockPrice) < 0.01) {
      document.getElementById('result').textContent = 
        `計算結果：1-5年 CAGR 應為 ${(mid * 100).toFixed(2)}%`;
      return;
    }
    
    if (calculatedPrice < stockPrice) {
      left = mid;
    } else {
      right = mid;
    }
    
    iterations++;
  }
  
  document.getElementById('result').textContent = '無法找到合適的CAGR值';
}

function calculatePriceWithCAGR(eps, cagr1_5, cagr6_10, discountRate, perpetualGrowthRate) {
  let presentValue = 0;
  let currentEPS = eps;

  // 計算1-5年的現值
  for (let i = 1; i <= 5; i++) {
    currentEPS *= (1 + cagr1_5);
    presentValue += currentEPS / Math.pow(1 + discountRate, i);
  }

  // 計算6-10年的現值
  for (let i = 6; i <= 10; i++) {
    currentEPS *= (1 + cagr6_10);
    presentValue += currentEPS / Math.pow(1 + discountRate, i);
  }

  // 計算永續價值
  const terminalValue = (currentEPS * (1 + perpetualGrowthRate)) / 
                       (discountRate - perpetualGrowthRate);
  const presentTerminalValue = terminalValue / Math.pow(1 + discountRate, 10);

  return presentValue + presentTerminalValue;
}

// 新增用於更新成長率輸入框狀態的函數
function updateGrowthInputs(yearCount) {
  for (let i = 1; i <= 5; i++) {
    const input = document.getElementById(`growth${i}`);
    input.disabled = i > yearCount;
    if (i > yearCount) {
      input.value = '';
    }
  }
}

// 新增計算複合成長率的函數
function calculateCompoundGrowth() {
  const yearCount = parseInt(document.getElementById('yearCount').value);
  const growthRates = [];
  
  // 收集所有成長率
  for (let i = 1; i <= yearCount; i++) {
    const rate = parseFloat(document.getElementById(`growth${i}`).value);
    if (isNaN(rate)) {
      document.getElementById('cagrResult').textContent = '請填寫所有必要的成長率';
      return;
    }
    growthRates.push(rate / 100); // 轉換為小數
  }
  
  // 計算最終值
  let initialValue = 1;
  let finalValue = initialValue;
  
  for (let rate of growthRates) {
    finalValue *= (1 + rate);
  }
  
  // 計算CAGR
  const cagr = (Math.pow(finalValue / initialValue, 1 / yearCount) - 1) * 100;
  
  document.getElementById('cagrResult').textContent = 
    `${yearCount}年的複合年均成長率(CAGR)為：${cagr.toFixed(2)}%`;
}

// 新增計算期初期末CAGR的函數
function calculateStartEndCAGR() {
  const years = parseFloat(document.getElementById('startEndYears').value);
  const startValue = parseFloat(document.getElementById('startValue').value);
  const endValue = parseFloat(document.getElementById('endValue').value);
  
  if (isNaN(years) || isNaN(startValue) || isNaN(endValue)) {
    document.getElementById('startEndResult').textContent = '請填寫所有必要欄位';
    return;
  }
  
  if (startValue <= 0 || endValue <= 0) {
    document.getElementById('startEndResult').textContent = '期初值和期末值必須大於0';
    return;
  }
  
  // 計算CAGR
  const cagr = (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
  
  document.getElementById('startEndResult').textContent = 
    `${years}年的複合年均成長率(CAGR)為：${cagr.toFixed(2)}%`;
} 