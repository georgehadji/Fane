# Beyond Leapfrog: How Neural Networks, Adaptive Steps, and New Formulas Are Reshaping Symplectic Integration

## The Limits of Classical Symplectic Integration

A conventional Runge–Kutta solver such as ode45 does not preserve the geometric structure of a Hamiltonian system. The SPINI paper links that failure to secular error accumulation and unphysical energy drift [1]. The drift in a given run still depends on the system, tolerance, step control, and integration horizon. Lack of symplecticity alone does not fix the error.

Symplectic integrators conserve the symplectic structure exactly, as the original Hamiltonian flow does [2]. That is not the same as conserving energy exactly. A symplectic method can still give poor long-time results if the step is too large or the implementation is unstable.

Leapfrog starts with a half-step update on momentum, then computes a full step in position using the half-updated momentum [3]. Two limits sit behind the newer work: non-separable systems, which prompt questions about high-order constructions [4], and timescale spread. Neither limit ranks the methods below. That would require matched error and cost comparisons, which these sources do not provide.

## Neural Networks Learn the Geometry

SPINI, short for Symplectic Physics-Informed Neural Network Integrator, has two stages. An unsupervised physics-informed neural network learns a Hamiltonian surrogate from the governing equations. Its multilayer perceptron takes phase-space coordinates \((q,p)\) and has two hidden layers with 256 neurons each. A second stage performs numerical integration, keeping system identification distinct from the integrator [1].

That leaves a gap. If the governing equations are already supplied, the sources do not say what unknown the surrogate recovers, what it replaces, or how its error enters the integration. Without training costs, failure rates, or the phase-space range covered in training, learning a surrogate is not shown to beat direct integration.

SympFlow builds its integrator from compositions of exact flow maps of parameterized, time-dependent Hamiltonian functions. Symplecticity and phase-space volume are preserved by design. The architecture alternates position-dependent and momentum-dependent maps, \(V_p\) and \(V_m\), both parameterized as multilayer perceptrons, and addresses long-timescale error accumulation in multiscale systems [5].

A symplectic learned map can still approximate the wrong dynamics. Preserving geometry and matching the target Hamiltonian are separate tests. The sources do not compare SPINI and SympFlow on either one. They also do not identify SPINI's integration stage in enough detail to rank its structural guarantee against SympFlow's.

## Adaptive Steps and Non-Separable Frontiers

Adaptive symplectic integration is not new. A common route applies the Poincaré transformation, which allows variable physical time steps while retaining symplectic integration in the transformed system [6, 7]. The guarantee belongs to that system, and adaptive stepping adds selection cost.

SQQ-PTQ, developed for gravitational dynamics, starts from the fixed-step SQQ integrator, derived from the principle of least action and generating functions. SQQ-PTQ replaces equidistant Lagrange interpolation with Chebyshev interpolation to approximate the action and eliminate the Runge phenomenon in that approximation. A projection method computes the interpolation functions and derivatives without matrix inversions at every step, while a time transformation decouples physical time from the integration step [8, 9]. Avoiding those inversions does not by itself prove lower total cost at matched accuracy.

DeepAI lists "Semiexplicit Symplectic Integrators for Non-Separable Hamiltonian Systems," but the scraped text has no abstract or technical details [10]. Extended phase space work includes the midpoint projection method, described as pseudosymplectic and pseudosymmetric, and the symmetric projection method, described as a monoimplicit symplectic Runge–Kutta method [11]. The labels do not settle whether extra variables, projection steps, and implicit work reduce cost or merely move it.

## The Road Ahead

SIAM lists "Explicit Symplectic Integrators Using Hessian–Vector Products," but the snippet gives no result on cost, order, or stages [12]. The evidence supports a narrower verdict: SPINI separates Hamiltonian learning from integration [1], SympFlow preserves symplecticity by construction [5], and SQQ-PTQ changes interpolation and evaluation inside an adaptive variational method [9]. These are different commitments, tested in different ways.

## Sources

1. [SPINI: a structure-preserving neural integrator for hamiltonian...](https://pmc.ncbi.nlm.nih.gov/articles/PMC12706080/)
2. [Recent progress in the theory and application of symplectic integrators](https://link.springer.com/article/10.1007/BF00699717)
3. [DeepHMC: a deep learning Hamiltonian Monte Carlo algorithm for...](https://theses.hal.science/tel-03642022v1/file/ARENE_Marc_va2.pdf)
4. [Symplectic integration for non-separable hamiltonian](https://math.stackexchange.com/questions/2140492/symplectic-integration-for-non-separable-hamiltonian)
5. [Hamiltonian Matching for Symplectic Neural Integrators](https://arxiv.org/html/2410.18262)
6. [UC San Diego](https://escholarship.org/content/qt9wm0q93j/qt9wm0q93j.pdf?t=osb2qu)
7. [(PDF) Adaptive Hamiltonian Variational Integrators and Applications to...](https://www.researchgate.net/publication/354018957_Adaptive_Hamiltonian_Variational_Integrators_and_Applications_to_Symplectic_Accelerated_Optimization)
8. [An adaptive symplectic integrator for gravitational dynamics](https://www.aanda.org/articles/aa/pdf/2025/07/aa51822-24.pdf)
9. [An adaptive symplectic integrator for gravitational dynamics](https://arxiv.org/html/2507.14881)
10. [Semiexplicit Symplectic Integrators for Non-separable... | DeepAI](https://deepai.org/publication/semiexplicit-symplectic-integrators-for-non-separable-hamiltonian-systems)
11. [Runge–Kutta methods determined from extended phase space...](https://link.springer.com/article/10.1007/s11075-024-01976-9)
12. [Explicit Symplectic Integrators Using Hessian--Vector Products](https://epubs.siam.org/doi/abs/10.1137/S1064827595288085?download=true&journalCode=sjoce3)
